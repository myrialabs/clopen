/**
 * Tunnel Store
 * Manages cloudflared tunnel runtime state (active tunnels, progress, errors)
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';

type TunnelType = 'quick' | 'remote' | 'local';

type TunnelProgress =
	| { stage: 'idle' }
	| { stage: 'checking-binary' }
	| { stage: 'downloading-binary'; progress?: number }
	| { stage: 'binary-ready' }
	| { stage: 'starting-tunnel' }
	| { stage: 'generating-url' }
	| { stage: 'connected' }
	| { stage: 'failed'; error: string };

interface IngressInfo {
	hostname?: string;
	service: string;
}

interface TunnelInfo {
	port: number;
	publicUrl: string;
	startedAt: string;
	autoStopMinutes: number;
	type: TunnelType;
	name?: string;
	id?: string;
	ingress?: IngressInfo[];
	/** Live edge connections to Cloudflare; > 0 means the tunnel is publicly reachable. */
	connections?: number;
}

interface LoadingState {
	isLoading: boolean;
	error: string | null;
	progress: TunnelProgress;
}

interface TunnelState {
	tunnels: TunnelInfo[];
	loadingStates: Record<string, LoadingState>;
}

const tunnelState = $state<TunnelState>({
	tunnels: [],
	loadingStates: {}
});

function setLoading(key: string): void {
	tunnelState.loadingStates[key] = {
		isLoading: true,
		error: null,
		progress: { stage: 'starting-tunnel' }
	};
}

function setConnected(key: string): void {
	if (tunnelState.loadingStates[key]) {
		tunnelState.loadingStates[key].progress = { stage: 'connected' };
		tunnelState.loadingStates[key].isLoading = false;
	}
	setTimeout(() => {
		if (tunnelState.loadingStates[key]) {
			tunnelState.loadingStates[key].progress = { stage: 'idle' };
		}
	}, 1500);
}

function setFailed(key: string, error: string): void {
	if (tunnelState.loadingStates[key]) {
		tunnelState.loadingStates[key].error = error;
		tunnelState.loadingStates[key].progress = { stage: 'failed', error };
		tunnelState.loadingStates[key].isLoading = false;
	}
}

export const tunnelStore = {
	get tunnels() {
		return tunnelState.tunnels;
	},

	get activeDomainCount() {
		let count = 0;
		for (const tunnel of tunnelState.tunnels) {
			const hostRules = tunnel.ingress?.filter((r) => r.hostname) ?? [];
			count += hostRules.length > 0 ? hostRules.length : (tunnel.publicUrl ? 1 : 0);
		}
		return count;
	},

	getLoadingState(key: string): LoadingState {
		return tunnelState.loadingStates[key] ?? { isLoading: false, error: null, progress: { stage: 'idle' } };
	},

	getTunnel(port: number) {
		return tunnelState.tunnels.find((t) => t.port === port && t.type === 'quick') ?? null;
	},

	// --- Quick tunnel ---

	async startQuickTunnel(port: number, autoStopMinutes?: number) {
		const key = String(port);
		setLoading(key);

		try {
			const result = await ws.http('tunnel:quick:start', { port, autoStopMinutes });

			if (!result?.publicUrl) throw new Error('No result received from server');

			tunnelState.tunnels.push({
				port,
				publicUrl: result.publicUrl,
				startedAt: new Date().toISOString(),
				autoStopMinutes: autoStopMinutes ?? 60,
				type: 'quick',
				connections: 0
			});

			setConnected(key);
			debug.log('tunnel', `Quick tunnel started on port ${port}: ${result.publicUrl}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			setFailed(key, msg);
			debug.error('tunnel', 'Quick tunnel error:', msg);
			throw error;
		}
	},

	async stopQuickTunnel(port: number) {
		try {
			const response = await ws.http('tunnel:quick:stop', { port });
			if (!response.stopped) throw new Error('Failed to stop tunnel');

			tunnelState.tunnels = tunnelState.tunnels.filter(
				(t) => !(t.port === port && t.type === 'quick')
			);
			delete tunnelState.loadingStates[String(port)];
		} catch (error) {
			debug.error('tunnel', 'Failed to stop quick tunnel:', error);
			throw error;
		}
	},

	// --- Remote tunnel ---

	async startRemoteTunnel(id: string) {
		setLoading(id);

		try {
			await ws.http('tunnel:remote:start', { id });
			setConnected(id);
			debug.log('tunnel', `Remote tunnel started: ${id}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			setFailed(id, msg);
			debug.error('tunnel', 'Remote tunnel error:', msg);
			throw error;
		}
	},

	async stopRemoteTunnel(id: string) {
		try {
			const response = await ws.http('tunnel:remote:stop', { id });
			if (!response.stopped) throw new Error('Failed to stop tunnel');

			tunnelState.tunnels = tunnelState.tunnels.filter(
				(t) => !(t.id === id && t.type === 'remote')
			);
			delete tunnelState.loadingStates[id];
		} catch (error) {
			debug.error('tunnel', 'Failed to stop remote tunnel:', error);
			throw error;
		}
	},

	// --- Local tunnel ---

	async startLocalTunnel(id: string) {
		setLoading(id);

		try {
			await ws.http('tunnel:local:start', { id });
			setConnected(id);
			debug.log('tunnel', `Local tunnel started: ${id}`);
		} catch (error) {
			const msg = error instanceof Error ? error.message : 'Unknown error';
			setFailed(id, msg);
			debug.error('tunnel', 'Local tunnel error:', msg);
			throw error;
		}
	},

	async stopLocalTunnel(id: string) {
		try {
			const response = await ws.http('tunnel:local:stop', { id });
			if (!response.stopped) throw new Error('Failed to stop tunnel');

			tunnelState.tunnels = tunnelState.tunnels.filter(
				(t) => !(t.id === id && t.type === 'local')
			);
			delete tunnelState.loadingStates[id];
		} catch (error) {
			debug.error('tunnel', 'Failed to stop local tunnel:', error);
			throw error;
		}
	},

	// --- Local auth ---

	async checkAuth(): Promise<{ authenticated: boolean; certPath: string; zone: string | null }> {
		return await ws.http('tunnel:local:auth-status', {});
	},

	async logout(): Promise<void> {
		await ws.http('tunnel:local:logout', {});
	},

	async setZone(zone: string): Promise<void> {
		await ws.http('tunnel:local:set-zone', { zone });
	},

	startLogin() {
		ws.emit('tunnel:local:login-start', {});
	},

	cancelLogin() {
		ws.emit('tunnel:local:login-cancel', {});
	},

	// --- Status ---

	async checkStatus() {
		try {
			const response = await ws.http('tunnel:status', {});
			tunnelState.tunnels = response.tunnels ?? [];
		} catch (error) {
			debug.error('tunnel', 'Failed to check tunnel status:', error);
		}
	},

	reset() {
		tunnelState.tunnels = [];
		tunnelState.loadingStates = {};
	},

	/** Update ingress for a specific tunnel (used by remote ingress-update events) */
	updateTunnelIngress(id: string, ingress: IngressInfo[]) {
		const tunnel = tunnelState.tunnels.find((t) => t.id === id);
		if (tunnel) {
			tunnel.ingress = ingress;
			// Also update publicUrl from first hostname
			const firstHostname = ingress.find((r) => r.hostname)?.hostname;
			if (firstHostname) {
				tunnel.publicUrl = `https://${firstHostname}`;
			}
		}
	},

	/** Initialize realtime tunnel status listener. Call once on app mount. */
	initRealtimeListener() {
		const cleanupStatus = ws.on('tunnel:status-changed', (data: { tunnels: TunnelInfo[] }) => {
			tunnelState.tunnels = data.tunnels;
		});

		const cleanupIngress = ws.on('tunnel:remote:ingress-update', (data: { id: string; ingress: IngressInfo[] }) => {
			tunnelStore.updateTunnelIngress(data.id, data.ingress);
		});

		return () => {
			cleanupStatus();
			cleanupIngress();
		};
	}
};
