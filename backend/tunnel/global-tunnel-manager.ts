/**
 * Global Tunnel Manager
 *
 * Manages three types of Cloudflare Tunnels:
 * - Quick: Random URL via trycloudflare.com (no account needed)
 * - Remote: Dashboard-managed tunnels via token (ConfigHandler for ingress sync)
 * - Local: Locally-managed tunnels (login, create, config file, run)
 */

import { debug } from '$shared/utils/logger';
import { existsSync, mkdirSync, renameSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getTunnelDir, getLocalTunnelConfigs } from './tunnel-config';
import type { RemoteTunnelConfig, LocalTunnelConfig } from './tunnel-config';
import { resolveCloudflaredBinary, CloudflaredTunnel, CloudflaredMissingError, type LoginHandle } from './cloudflared';

// --- Types ---

export type TunnelType = 'quick' | 'remote' | 'local';

export interface IngressInfo {
	hostname?: string;
	service: string;
}

interface BaseTunnelInstance {
	tunnel: CloudflaredTunnel;
	startedAt: Date;
	type: TunnelType;
}

interface QuickTunnelInstance extends BaseTunnelInstance {
	type: 'quick';
	publicUrl: string;
	localPort: number;
	autoStopMinutes: number;
	autoStopTimer?: ReturnType<typeof setTimeout>;
}

interface RemoteTunnelInstance extends BaseTunnelInstance {
	type: 'remote';
	configId: string;
	label: string;
	ingress: IngressInfo[];
}

interface LocalTunnelInstance extends BaseTunnelInstance {
	type: 'local';
	configId: string;
	name: string;
	ingress: IngressInfo[];
}

// --- Cloudflared paths ---

const CERT_PATH = join(getTunnelDir(), 'cert.pem');
const DEFAULT_CLOUDFLARED_CERT = join(homedir(), '.cloudflared', 'cert.pem');

function isTunnelNameConflict(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /tunnel with name already exists/i.test(message);
}

// --- Manager ---

class GlobalTunnelManager {
	private quickTunnels = new Map<number, QuickTunnelInstance>();
	private remoteTunnels = new Map<string, RemoteTunnelInstance>();
	private localTunnels = new Map<string, LocalTunnelInstance>();
	private loginHandle: LoginHandle | null = null;

	// Callback for pushing ingress updates to connected clients
	private onRemoteIngressUpdate?: (configId: string, ingress: IngressInfo[]) => void;
	// Callback for pushing tunnel list changes
	private onStatusChanged?: () => void;

	setRemoteIngressUpdateCallback(cb: (configId: string, ingress: IngressInfo[]) => void): void {
		this.onRemoteIngressUpdate = cb;
	}

	setStatusChangedCallback(cb: () => void): void {
		this.onStatusChanged = cb;
	}

	private notifyStatusChanged(): void {
		this.onStatusChanged?.();
	}

	// --- Binary management ---

	/**
	 * Verify cloudflared is available before a tunnel operation. Never
	 * downloads — installation is user-initiated through Settings → System
	 * Tools. Throws CloudflaredMissingError when nothing is resolvable.
	 */
	private ensureBinaryAvailable(
		onProgress?: (stage: string, data?: any) => void
	): void {
		const resolved = resolveCloudflaredBinary();
		if (!resolved) {
			debug.warn('tunnel', 'Cloudflared binary not available; install via Settings → System Tools');
			throw new CloudflaredMissingError();
		}
		debug.log('tunnel', 'Cloudflared binary available at:', resolved);
		onProgress?.('binary-ready', { cached: true });
	}

	// --- Quick tunnel ---

	async startQuickTunnel(
		port: number,
		autoStopMinutes: number = 60,
		onProgress?: (stage: string, data?: any) => void
	): Promise<{ publicUrl: string; timings: Record<string, number> }> {
		onProgress?.('checking-binary');
		this.ensureBinaryAvailable(onProgress);
		const timings: Record<string, number> = {};

		if (this.quickTunnels.has(port)) {
			const existing = this.quickTunnels.get(port)!;
			return { publicUrl: existing.publicUrl, timings };
		}

		onProgress?.('starting-tunnel', { port });
		const tunnelStartTime = Date.now();

		try {
			const tunnel = CloudflaredTunnel.quick(`http://localhost:${port}`);

			tunnel.on('error', (error: Error) => debug.error('tunnel', `[quick:${port}] error:`, error));
			tunnel.on('exit', (code: number | null) => {
				debug.log('tunnel', `[quick:${port}] exit code ${code}`);
				this.quickTunnels.delete(port);
				this.notifyStatusChanged();
			});

			onProgress?.('generating-url');

			const publicUrl: string = await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					tunnel.stop();
					reject(new Error(`Tunnel connection timeout (30s). Please check if port ${port} is accessible.`));
				}, 30000);

				tunnel.on('url', (url: string) => {
					if (url.includes('api.trycloudflare.com')) return;
					clearTimeout(timeout);
					resolve(url);
				});

				tunnel.on('error', (error: Error) => {
					clearTimeout(timeout);
					reject(error);
				});

				tunnel.once('exit', (code: number | null) => {
					if (code !== 0 && code !== null) {
						clearTimeout(timeout);
						reject(new Error(`Tunnel failed to start (exit code ${code}).`));
					}
				});
			});

			timings.tunnelStart = Date.now() - tunnelStartTime;

			let autoStopTimer: ReturnType<typeof setTimeout> | undefined;
			if (autoStopMinutes > 0) {
				autoStopTimer = setTimeout(async () => {
					debug.log('tunnel', `Auto-stopping quick tunnel on port ${port}`);
					await this.stopQuickTunnel(port);
				}, autoStopMinutes * 60 * 1000);
			}

			this.quickTunnels.set(port, {
				tunnel,
				publicUrl,
				localPort: port,
				type: 'quick',
				startedAt: new Date(),
				autoStopMinutes,
				autoStopTimer
			});

			debug.log('tunnel', `Quick tunnel started on port ${port}: ${publicUrl}`);
			onProgress?.('connected', { publicUrl, timings });
			this.notifyStatusChanged();

			return { publicUrl, timings };
		} catch (error) {
			debug.error('tunnel', `Failed to start quick tunnel on port ${port}:`, error);
			throw error;
		}
	}

	async stopQuickTunnel(port: number): Promise<void> {
		const instance = this.quickTunnels.get(port);
		if (!instance) return;

		if (instance.autoStopTimer) clearTimeout(instance.autoStopTimer);
		try {
			instance.tunnel.stop();
		} catch (err) {
			debug.warn('tunnel', `Failed to stop quick tunnel on port ${port}:`, err);
		}
		this.quickTunnels.delete(port);
		debug.log('tunnel', `Quick tunnel stopped on port ${port}`);
		this.notifyStatusChanged();
	}

	// --- Remote tunnel (dashboard-managed) ---

	async startRemoteTunnel(
		config: RemoteTunnelConfig,
		onProgress?: (stage: string, data?: any) => void
	): Promise<{ timings: Record<string, number> }> {
		onProgress?.('checking-binary');
		this.ensureBinaryAvailable(onProgress);
		const timings: Record<string, number> = {};

		if (this.remoteTunnels.has(config.id)) {
			return { timings };
		}

		onProgress?.('starting-tunnel', { label: config.label });
		const tunnelStartTime = Date.now();

		try {
			const tunnel = CloudflaredTunnel.withToken(config.token);

			const instance: RemoteTunnelInstance = {
				tunnel,
				type: 'remote',
				configId: config.id,
				label: config.label,
				startedAt: new Date(),
				ingress: []
			};

			// Sync ingress from config events (emitted by the tunnel's built-in config handler)
			tunnel.on('config', (data: { config: any; version: number }) => {
				if (data.config?.ingress && Array.isArray(data.config.ingress)) {
					instance.ingress = data.config.ingress.map((rule: any) => ({
						hostname: rule.hostname,
						service: rule.service
					}));
					debug.log('tunnel', `[remote:${config.label}] Config synced, ${instance.ingress.length} ingress rules`);
					this.onRemoteIngressUpdate?.(config.id, instance.ingress);
				}
			});

			tunnel.on('error', (error: Error) => debug.error('tunnel', `[remote:${config.label}] error:`, error));
			tunnel.on('exit', (code: number | null) => {
				debug.log('tunnel', `[remote:${config.label}] exit code ${code}`);
				this.remoteTunnels.delete(config.id);
				this.notifyStatusChanged();
			});

			onProgress?.('generating-url');

			// Wait for first connection
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					tunnel.stop();
					reject(new Error('Remote tunnel connection timeout (60s). Please check your token.'));
				}, 60000);

				tunnel.once('connected', () => {
					clearTimeout(timeout);
					resolve();
				});

				tunnel.once('error', (error: Error) => {
					clearTimeout(timeout);
					tunnel.stop();
					reject(error);
				});

				tunnel.once('exit', (code: number | null) => {
					if (code !== 0 && code !== null) {
						clearTimeout(timeout);
						reject(new Error(`Remote tunnel failed (exit code ${code}). Please verify your token.`));
					}
				});
			});

			timings.tunnelStart = Date.now() - tunnelStartTime;
			this.remoteTunnels.set(config.id, instance);

			debug.log('tunnel', `Remote tunnel started: ${config.label}`);
			onProgress?.('connected', { timings });
			this.notifyStatusChanged();

			return { timings };
		} catch (error) {
			debug.error('tunnel', `Failed to start remote tunnel ${config.label}:`, error);
			throw error;
		}
	}

	async stopRemoteTunnel(configId: string): Promise<void> {
		const instance = this.remoteTunnels.get(configId);
		if (!instance) return;

		try {
			instance.tunnel.stop();
		} catch (err) {
			debug.warn('tunnel', `Failed to stop remote tunnel ${instance.label}:`, err);
		}
		this.remoteTunnels.delete(configId);
		debug.log('tunnel', `Remote tunnel stopped: ${instance.label}`);
		this.notifyStatusChanged();
	}

	getRemoteTunnelIngress(configId: string): IngressInfo[] {
		return this.remoteTunnels.get(configId)?.ingress ?? [];
	}

	isRemoteTunnelActive(configId: string): boolean {
		return this.remoteTunnels.has(configId);
	}

	// --- Local tunnel (locally-managed) ---

	checkCloudflaredAuth(): { authenticated: boolean; certPath: string } {
		// Migrate cert from default cloudflared location if it exists there but not in our dir
		if (!existsSync(CERT_PATH) && existsSync(DEFAULT_CLOUDFLARED_CERT)) {
			this.moveCertToTunnelDir();
		}
		const authenticated = existsSync(CERT_PATH);
		return { authenticated, certPath: CERT_PATH };
	}

	async loginCloudflared(
		onUrl?: (url: string) => void,
		onComplete?: () => void,
		onError?: (error: string) => void
	): Promise<void> {
		this.ensureBinaryAvailable();

		if (this.loginHandle) {
			onError?.('Login process already running');
			return;
		}

		debug.log('tunnel', 'Starting cloudflared login...');

		this.loginHandle = CloudflaredTunnel.login({
			onUrl: (url) => {
				debug.log('tunnel', `[login] Auth URL: ${url}`);
				onUrl?.(url);
			},
			onComplete: () => {
				this.loginHandle = null;
				// Move cert.pem from ~/.cloudflared/ to our tunnel dir
				this.moveCertToTunnelDir();
				debug.log('tunnel', 'Cloudflared login successful');
				onComplete?.();
			},
			onError: (message) => {
				this.loginHandle = null;
				debug.error('tunnel', `Cloudflared login failed: ${message}`);
				onError?.(message);
			}
		});
	}

	private moveCertToTunnelDir(): void {
		if (existsSync(DEFAULT_CLOUDFLARED_CERT)) {
			const tunnelDir = getTunnelDir();
			if (!existsSync(tunnelDir)) {
				mkdirSync(tunnelDir, { recursive: true });
			}
			renameSync(DEFAULT_CLOUDFLARED_CERT, CERT_PATH);
			debug.log('tunnel', `Cert moved: ${DEFAULT_CLOUDFLARED_CERT} -> ${CERT_PATH}`);
		}
	}

	cancelLogin(): void {
		if (this.loginHandle) {
			debug.log('tunnel', 'Cloudflared login cancelled by user');
			this.loginHandle.cancel();
			this.loginHandle = null;
		}
	}

	logoutCloudflared(): { success: boolean } {
		try {
			if (existsSync(CERT_PATH)) {
				unlinkSync(CERT_PATH);
				debug.log('tunnel', 'Cloudflared cert.pem removed (logged out)');
			}
			return { success: true };
		} catch (error) {
			debug.error('tunnel', 'Failed to remove cert.pem:', error);
			return { success: false };
		}
	}

	async createLocalTunnel(name: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		this.ensureBinaryAvailable();

		try {
			return await this.runCreateLocalTunnel(name);
		} catch (error) {
			if (!isTunnelNameConflict(error)) throw error;

			// Name collides on Cloudflare. Auto-recover only when it's a true orphan,
			// then retry once. Anything else surfaces a clear, actionable message.
			await this.resolveTunnelNameConflict(name);
			return await this.runCreateLocalTunnel(name);
		}
	}

	private async runCreateLocalTunnel(name: string): Promise<{ tunnelId: string; credentialsFile: string }> {
		// Write credentials directly to our dir (not ~/.cloudflared/)
		const tunnelBaseDir = getTunnelDir();
		if (!existsSync(tunnelBaseDir)) {
			mkdirSync(tunnelBaseDir, { recursive: true });
		}
		const tempCredentials = join(tunnelBaseDir, `${name}.json`);
		const result = await CloudflaredTunnel.createTunnel(name, { credentialsFile: tempCredentials, origincert: CERT_PATH });

		// Organize into {tunnelId}/ subdirectory
		const tunnelDir = join(tunnelBaseDir, result.tunnelId);
		if (!existsSync(tunnelDir)) {
			mkdirSync(tunnelDir, { recursive: true });
		}
		const finalCredentials = join(tunnelDir, 'credentials.json');
		renameSync(tempCredentials, finalCredentials);

		debug.log('tunnel', `Local tunnel created: ${name} (${result.tunnelId})`);
		return { tunnelId: result.tunnelId, credentialsFile: finalCredentials };
	}

	/**
	 * Handle a "tunnel with name already exists" conflict. A tunnel that exists on
	 * Cloudflare but isn't tracked locally and has no active connections is an orphan
	 * (usually a half-failed create) and is safe to delete so the create can retry.
	 * Everything else throws a clear message instead.
	 */
	private async resolveTunnelNameConflict(name: string): Promise<void> {
		let existing;
		try {
			existing = await CloudflaredTunnel.listTunnels({ origincert: CERT_PATH });
		} catch (listError) {
			debug.warn('tunnel', 'Could not list tunnels to resolve name conflict:', listError);
			throw new Error(`A Cloudflare tunnel named "${name}" already exists on your account. Choose a different name, or remove it from the Cloudflare dashboard.`);
		}

		const match = existing.find((t) => t.name === name);
		if (!match) {
			throw new Error(`A Cloudflare tunnel named "${name}" already exists on your account. Choose a different name, or remove it from the Cloudflare dashboard.`);
		}

		if (getLocalTunnelConfigs().some((c) => c.tunnelId === match.id)) {
			throw new Error(`A tunnel named "${name}" already exists. Choose a different name, or delete the existing tunnel first.`);
		}

		if (match.connections.length > 0) {
			throw new Error(`A Cloudflare tunnel named "${name}" already exists and has active connections. Choose a different name, or remove it from the Cloudflare dashboard.`);
		}

		debug.warn('tunnel', `Orphaned tunnel "${name}" (${match.id}) found on Cloudflare; deleting before recreate`);
		await CloudflaredTunnel.deleteTunnel(match.id, { force: true, origincert: CERT_PATH });
		this.cleanupLocalTunnelFiles(match.id);
	}

	async deleteLocalTunnel(tunnelId: string, credentialsFile?: string): Promise<void> {
		this.ensureBinaryAvailable();

		await CloudflaredTunnel.deleteTunnel(tunnelId, { credentialsFile, origincert: CERT_PATH });
		debug.log('tunnel', `Local tunnel deleted: ${tunnelId}`);
	}

	cleanupLocalTunnelFiles(tunnelId: string): void {
		const configDir = join(getTunnelDir(), tunnelId);
		if (existsSync(configDir)) {
			rmSync(configDir, { recursive: true });
			debug.log('tunnel', `Tunnel config directory removed: ${configDir}`);
		}
	}

	async routeDns(tunnelName: string, hostname: string): Promise<{ alreadyExists: boolean }> {
		this.ensureBinaryAvailable();

		const result = await CloudflaredTunnel.routeDns(tunnelName, hostname, { overwriteDns: true, origincert: CERT_PATH });
		debug.log('tunnel', `DNS route ${result.alreadyExists ? 'updated' : 'added'}: ${hostname} -> ${tunnelName}`);
		return result;
	}

	writeLocalTunnelConfig(config: LocalTunnelConfig): string {
		const configDir = join(getTunnelDir(), config.tunnelId);
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}

		const configPath = join(configDir, 'config.yml');

		const ingressRules = [
			...config.ingress.map((r) => `  - hostname: ${r.hostname}\n    service: ${r.service}`),
			'  - service: http_status:404'
		];

		const yml = [
			`tunnel: ${config.tunnelId}`,
			`credentials-file: ${config.credentialsFile}`,
			'ingress:',
			...ingressRules
		].join('\n');

		writeFileSync(configPath, yml, 'utf-8');
		debug.log('tunnel', `Config file written: ${configPath}`);
		return configPath;
	}

	async startLocalTunnel(
		config: LocalTunnelConfig,
		onProgress?: (stage: string, data?: any) => void
	): Promise<{ timings: Record<string, number> }> {
		onProgress?.('checking-binary');
		this.ensureBinaryAvailable(onProgress);
		const timings: Record<string, number> = {};

		if (this.localTunnels.has(config.id)) {
			return { timings };
		}

		if (config.ingress.length === 0) {
			throw new Error('Cannot start tunnel without ingress rules. Add at least one hostname mapping.');
		}

		// Write config file
		const configPath = this.writeLocalTunnelConfig(config);

		onProgress?.('starting-tunnel', { name: config.name });
		const tunnelStartTime = Date.now();

		try {
			const tunnel = CloudflaredTunnel.withConfig(configPath);

			tunnel.on('error', (error: Error) => debug.error('tunnel', `[local:${config.name}] error:`, error));
			tunnel.on('exit', (code: number | null) => {
				debug.log('tunnel', `[local:${config.name}] exit code ${code}`);
				this.localTunnels.delete(config.id);
				this.notifyStatusChanged();
			});

			onProgress?.('generating-url');

			// Wait for first connection
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					tunnel.stop();
					reject(new Error('Local tunnel connection timeout (60s). Check your config and credentials.'));
				}, 60000);

				tunnel.once('connected', () => {
					clearTimeout(timeout);
					resolve();
				});

				tunnel.once('error', (error: Error) => {
					clearTimeout(timeout);
					tunnel.stop();
					reject(error);
				});

				tunnel.once('exit', (code: number | null) => {
					if (code !== 0 && code !== null) {
						clearTimeout(timeout);
						reject(new Error(`Local tunnel failed (exit code ${code}).`));
					}
				});
			});

			timings.tunnelStart = Date.now() - tunnelStartTime;

			const instance: LocalTunnelInstance = {
				tunnel,
				type: 'local',
				configId: config.id,
				name: config.name,
				startedAt: new Date(),
				ingress: config.ingress.map((r) => ({ hostname: r.hostname, service: r.service }))
			};

			this.localTunnels.set(config.id, instance);
			debug.log('tunnel', `Local tunnel started: ${config.name}`);
			onProgress?.('connected', { timings });
			this.notifyStatusChanged();

			return { timings };
		} catch (error) {
			debug.error('tunnel', `Failed to start local tunnel ${config.name}:`, error);
			throw error;
		}
	}

	async stopLocalTunnel(configId: string): Promise<void> {
		const instance = this.localTunnels.get(configId);
		if (!instance) return;

		try {
			instance.tunnel.stop();
		} catch (err) {
			debug.warn('tunnel', `Failed to stop local tunnel ${instance.name}:`, err);
		}
		this.localTunnels.delete(configId);
		debug.log('tunnel', `Local tunnel stopped: ${instance.name}`);
		this.notifyStatusChanged();
	}

	isLocalTunnelActive(configId: string): boolean {
		return this.localTunnels.has(configId);
	}

	// --- Status / global ---

	getActiveTunnels(): Array<{
		port: number;
		publicUrl: string;
		startedAt: string;
		autoStopMinutes: number;
		type: TunnelType;
		label?: string;
		configId?: string;
		ingress?: IngressInfo[];
	}> {
		const tunnels: ReturnType<typeof this.getActiveTunnels> = [];

		for (const [port, instance] of this.quickTunnels) {
			tunnels.push({
				port,
				publicUrl: instance.publicUrl,
				startedAt: instance.startedAt.toISOString(),
				autoStopMinutes: instance.autoStopMinutes,
				type: 'quick'
			});
		}

		for (const [, instance] of this.remoteTunnels) {
			const firstHostname = instance.ingress.find((r) => r.hostname)?.hostname;
			tunnels.push({
				port: 0,
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: instance.startedAt.toISOString(),
				autoStopMinutes: 0,
				type: 'remote',
				label: instance.label,
				configId: instance.configId,
				ingress: instance.ingress
			});
		}

		for (const [, instance] of this.localTunnels) {
			const firstHostname = instance.ingress.find((r) => r.hostname)?.hostname;
			tunnels.push({
				port: 0,
				publicUrl: firstHostname ? `https://${firstHostname}` : '',
				startedAt: instance.startedAt.toISOString(),
				autoStopMinutes: 0,
				type: 'local',
				label: instance.name,
				configId: instance.configId,
				ingress: instance.ingress
			});
		}

		return tunnels;
	}

	async stopAllTunnels(): Promise<void> {
		debug.log('tunnel', 'Stopping all tunnels...');

		const ops: Promise<void>[] = [];
		for (const port of this.quickTunnels.keys()) ops.push(this.stopQuickTunnel(port));
		for (const id of this.remoteTunnels.keys()) ops.push(this.stopRemoteTunnel(id));
		for (const id of this.localTunnels.keys()) ops.push(this.stopLocalTunnel(id));

		await Promise.all(ops);
		debug.log('tunnel', 'All tunnels stopped');
	}
}

// Singleton
export const globalTunnelManager = new GlobalTunnelManager();
