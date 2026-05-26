/**
 * Cloudflared Tunnel
 *
 * EventEmitter wrapper around cloudflared child process.
 * Replaces the `Tunnel` class from the `cloudflared` npm package.
 *
 * Events:
 * - 'url'         (url: string)                    - TryCloudflare URL generated
 * - 'connected'   (info: ConnectionInfo)            - Tunnel connection established
 * - 'disconnected'(info: ConnectionInfo)            - Tunnel connection lost
 * - 'config'      (data: { config: any; version: number }) - Config update (remote tunnels)
 * - 'error'       (error: Error)                    - Error occurred
 * - 'exit'        (code: number | null, signal: string | null) - Process exited
 * - 'stdout'      (data: string)                    - Raw stdout output
 * - 'stderr'      (data: string)                    - Raw stderr output
 */

import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir, platform } from 'os';
import { join } from 'path';
import { resolveCloudflaredBinary } from './binary';

export class CloudflaredMissingError extends Error {
	constructor() {
		super('Cloudflared binary is not installed. Install it from Settings → System Tools, or install cloudflared system-wide and restart clopen.');
		this.name = 'CloudflaredMissingError';
	}
}

function requireBinary(): string {
	const resolved = resolveCloudflaredBinary();
	if (!resolved) throw new CloudflaredMissingError();
	return resolved;
}

// --- Output parsing regexes (from cloudflared npm package) ---

const CONN_REGEX = /connection[= ]([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const IP_REGEX = /ip=([0-9.]+)/;
const LOCATION_REGEX = /location=([A-Za-z0-9]+)/;
const INDEX_REGEX = /connIndex=(\d)/;
const TRYCLOUDFLARE_REGEX = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/;
const CONFIG_REGEX = /\bconfig="(.+?)" version=(\d+)/;

export interface ConnectionInfo {
	id: string;
	ip: string;
	location: string;
}

export interface LoginHandle {
	process: ChildProcess;
	cancel: () => void;
}

export interface LoginCallbacks {
	onUrl: (url: string) => void;
	onComplete: () => void;
	onError: (message: string) => void;
}

export interface LoginOptions {
	/** Prevent cloudflared from auto-opening a browser. Default: `true` */
	preventBrowserOpen?: boolean;
}

export interface CreateTunnelOptions {
	/** Custom path for the credentials file output */
	credentialsFile?: string;
	/** Base64-encoded tunnel secret (must decode to >= 32 bytes) */
	secret?: string;
	/** Custom path for the origin certificate */
	origincert?: string;
}

export interface CreateTunnelResult {
	tunnelId: string;
	credentialsFile: string;
	output: string;
}

export interface DeleteTunnelOptions {
	/** Force delete even if tunnel has active connections. Default: `false` */
	force?: boolean;
	/** Custom path for the credentials file */
	credentialsFile?: string;
	/** Custom path for the origin certificate */
	origincert?: string;
}

export interface DeleteTunnelResult {
	output: string;
}

export interface RouteDnsOptions {
	/** Overwrite existing DNS record for this hostname. Default: `false` */
	overwriteDns?: boolean;
	/** Custom path for the origin certificate */
	origincert?: string;
}

export interface RouteDnsResult {
	alreadyExists: boolean;
	output: string;
}

export interface ListTunnelsOptions {
	/** Custom path for the origin certificate */
	origincert?: string;
}

export interface TunnelListEntry {
	id: string;
	name: string;
	connections: unknown[];
}

type OutputHandler = (output: string, tunnel: CloudflaredTunnel) => void;

export class CloudflaredTunnel extends EventEmitter {
	private _process: ChildProcess;
	private outputHandlers: OutputHandler[] = [];
	private connections: (ConnectionInfo | undefined)[] = [];

	constructor(args: string[]) {
		super();
		this.setupDefaultHandlers();
		this._process = this.createProcess(args);
		this.setupEventRouting();
	}

	get process(): ChildProcess {
		return this._process;
	}

	/** Stop the tunnel process */
	stop(): boolean {
		return this._process.kill('SIGINT');
	}

	/** Add a custom output handler */
	addHandler(handler: OutputHandler): void {
		this.outputHandlers.push(handler);
	}

	// --- Static factory methods ---

	/** Create a quick tunnel (TryCloudflare, no account needed) */
	static quick(url?: string): CloudflaredTunnel {
		const args = url
			? ['tunnel', '--url', url]
			: ['tunnel', '--hello-world'];
		return new CloudflaredTunnel(args);
	}

	/** Create a tunnel with a Cloudflare token (dashboard-managed) */
	static withToken(token: string): CloudflaredTunnel {
		return new CloudflaredTunnel(['tunnel', 'run', '--token', token]);
	}

	/** Create a tunnel with a local config file */
	static withConfig(configPath: string): CloudflaredTunnel {
		return new CloudflaredTunnel(['tunnel', '--config', configPath, 'run']);
	}

	// --- Static commands ---

	/**
	 * Start `cloudflared tunnel login`.
	 * Returns a handle with `.cancel()` to abort the process.
	 */
	static login(callbacks: LoginCallbacks, options?: LoginOptions): LoginHandle {
		const preventBrowserOpen = options?.preventBrowserOpen ?? true;

		let env = process.env;

		if (preventBrowserOpen) {
			const fakeOpenDir = join(tmpdir(), 'cloudflared-noop-open');
			if (!existsSync(fakeOpenDir)) mkdirSync(fakeOpenDir, { recursive: true });
			const fakeScript = '#!/bin/sh\nexit 0\n';
			const cmds = platform() === 'darwin' ? ['open'] : ['xdg-open', 'sensible-browser', 'x-www-browser'];
			for (const cmd of cmds) {
				const p = join(fakeOpenDir, cmd);
				if (!existsSync(p)) {
					writeFileSync(p, fakeScript, { mode: 0o755 });
					chmodSync(p, 0o755);
				}
			}
			env = { ...process.env, BROWSER: 'false', PATH: `${fakeOpenDir}:${process.env.PATH ?? ''}` };
		}

		const proc = spawn(requireBinary(), ['tunnel', 'login'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env
		});

		let urlSent = false;
		let cancelled = false;

		const handleOutput = (data: Buffer) => {
			if (cancelled) return;
			const output = data.toString();
			if (!urlSent) {
				const urlMatch = output.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\S+/);
				if (urlMatch) {
					urlSent = true;
					callbacks.onUrl(urlMatch[0]);
				}
			}
		};

		proc.stdout?.on('data', handleOutput);
		proc.stderr?.on('data', handleOutput);

		proc.on('exit', (code) => {
			if (cancelled) return;
			if (code === 0) callbacks.onComplete();
			else callbacks.onError(`Login failed (exit code ${code})`);
		});

		proc.on('error', (error) => {
			if (cancelled) return;
			callbacks.onError(error.message);
		});

		return {
			process: proc,
			cancel() {
				cancelled = true;
				proc.kill('SIGTERM');
			}
		};
	}

	/** Create a named tunnel. Returns tunnel UUID and credentials file path. */
	static async createTunnel(name: string, options?: CreateTunnelOptions): Promise<CreateTunnelResult> {
		const args = ['tunnel'];
		if (options?.origincert) args.push('--origincert', options.origincert);
		args.push('create');
		if (options?.credentialsFile) args.push('--credentials-file', options.credentialsFile);
		if (options?.secret) args.push('--secret', options.secret);
		args.push(name);

		const { output, exitCode } = await CloudflaredTunnel.run(args);

		if (exitCode !== 0) {
			throw new Error(`Failed to create tunnel (exit code ${exitCode}): ${output.trim()}`);
		}

		const idMatch = output.match(/with id ([a-f0-9-]+)/);
		const credMatch = output.match(/credentials written to (.+\.json)/);

		if (!idMatch || !credMatch) {
			throw new Error(`Could not parse tunnel creation output: ${output}`);
		}

		return { tunnelId: idMatch[1], credentialsFile: credMatch[1].trim(), output };
	}

	/** Delete a tunnel by UUID or name. */
	static async deleteTunnel(tunnel: string, options?: DeleteTunnelOptions): Promise<DeleteTunnelResult> {
		const args = ['tunnel'];
		if (options?.origincert) args.push('--origincert', options.origincert);
		args.push('delete');
		if (options?.force) args.push('--force');
		if (options?.credentialsFile) args.push('--credentials-file', options.credentialsFile);
		args.push(tunnel);

		const { output, exitCode } = await CloudflaredTunnel.run(args);

		if (exitCode !== 0) {
			throw new Error(`Failed to delete tunnel: ${output.trim()}`);
		}

		return { output };
	}

	/** Create a CNAME DNS record pointing hostname to a tunnel. */
	static async routeDns(tunnel: string, hostname: string, options?: RouteDnsOptions): Promise<RouteDnsResult> {
		const args = ['tunnel'];
		if (options?.origincert) args.push('--origincert', options.origincert);
		args.push('route', 'dns');
		if (options?.overwriteDns) args.push('--overwrite-dns');
		args.push(tunnel, hostname);

		const { output, exitCode } = await CloudflaredTunnel.run(args);

		if (exitCode === 0) {
			return { alreadyExists: /already exists|updated/i.test(output), output };
		}

		// DNS already points to this tunnel — treat as success
		if (/already exists|CNAME.*already/i.test(output)) {
			return { alreadyExists: true, output };
		}

		throw new Error(`Failed to route DNS: ${output.trim()}`);
	}

	/** List all tunnels on the authenticated Cloudflare account. */
	static async listTunnels(options?: ListTunnelsOptions): Promise<TunnelListEntry[]> {
		const args = ['tunnel'];
		if (options?.origincert) args.push('--origincert', options.origincert);
		args.push('list', '--output', 'json');

		const { output, exitCode } = await CloudflaredTunnel.run(args);

		if (exitCode !== 0) {
			throw new Error(`Failed to list tunnels: ${output.trim()}`);
		}

		// cloudflared prints warnings (e.g. outdated-version notice) alongside the
		// JSON array, so isolate the array span before parsing.
		const start = output.indexOf('[');
		const end = output.lastIndexOf(']');
		if (start === -1 || end === -1 || end < start) return [];

		try {
			const parsed = JSON.parse(output.slice(start, end + 1));
			if (!Array.isArray(parsed)) return [];
			return parsed.map((entry) => ({
				id: String(entry.id),
				name: String(entry.name),
				connections: Array.isArray(entry.connections) ? entry.connections : []
			}));
		} catch {
			return [];
		}
	}

	// --- Private helpers ---

	/** Run a one-shot cloudflared command and collect all output. */
	private static run(args: string[]): Promise<{ output: string; exitCode: number }> {
		return new Promise((resolve, reject) => {
			const proc = spawn(requireBinary(), args, {
				stdio: ['ignore', 'pipe', 'pipe']
			});

			let output = '';
			proc.stdout?.on('data', (data: Buffer) => { output += data.toString(); });
			proc.stderr?.on('data', (data: Buffer) => { output += data.toString(); });

			proc.on('exit', (code) => resolve({ output, exitCode: code ?? 1 }));
			proc.on('error', (error) => reject(error));
		});
	}

	// --- Internal ---

	private setupDefaultHandlers(): void {
		// Connection handler
		this.addHandler((output, tunnel) => {
			const connMatch = output.match(CONN_REGEX);
			const ipMatch = output.match(IP_REGEX);
			const locationMatch = output.match(LOCATION_REGEX);
			const indexMatch = output.match(INDEX_REGEX);

			if (connMatch && ipMatch && locationMatch && indexMatch) {
				const info: ConnectionInfo = {
					id: connMatch[1],
					ip: ipMatch[1],
					location: locationMatch[1]
				};
				this.connections[Number(indexMatch[1])] = info;
				tunnel.emit('connected', info);
			}

			// Disconnection
			if (output.includes('terminated')) {
				const idxMatch = output.match(INDEX_REGEX);
				if (idxMatch) {
					const idx = Number(idxMatch[1]);
					if (this.connections[idx]) {
						tunnel.emit('disconnected', this.connections[idx]);
						this.connections[idx] = undefined;
					}
				}
			}
		});

		// TryCloudflare URL handler
		this.addHandler((output, tunnel) => {
			const urlMatch = output.match(TRYCLOUDFLARE_REGEX);
			if (urlMatch) {
				tunnel.emit('url', urlMatch[0]);
			}
		});

		// Config handler (for remote/token-based tunnels)
		this.addHandler((output, tunnel) => {
			const configMatch = output.match(CONFIG_REGEX);
			if (configMatch) {
				try {
					const configStr = configMatch[1].replace(/\\"/g, '"');
					const config = JSON.parse(configStr);
					const version = parseInt(configMatch[2], 10);
					tunnel.emit('config', { config, version });

					// Also emit URL for each ingress hostname
					if (config?.ingress && Array.isArray(config.ingress)) {
						for (const ingress of config.ingress) {
							if (ingress.hostname) {
								tunnel.emit('url', ingress.hostname);
							}
						}
					}
				} catch {
					// Ignore parse errors
				}
			}
		});
	}

	private createProcess(args: string[]): ChildProcess {
		const binPath = requireBinary();
		const child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

		child.on('error', (error) => this.emit('error', error));
		child.on('exit', (code, signal) => this.emit('exit', code, signal));

		child.stdout?.on('data', (data: Buffer) => this.emit('stdout', data.toString()));
		child.stderr?.on('data', (data: Buffer) => this.emit('stderr', data.toString()));

		return child;
	}

	private setupEventRouting(): void {
		const processOutput = (output: string) => {
			for (const handler of this.outputHandlers) {
				try {
					handler(output, this);
				} catch (error) {
					this.emit('error', error instanceof Error ? error : new Error(String(error)));
				}
			}
		};

		this.on('stdout', processOutput);
		this.on('stderr', processOutput);
	}
}
