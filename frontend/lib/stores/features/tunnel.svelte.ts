/**
 * Tunnel Store
 * Manages cloudflared tunnel state for projects
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

type TunnelProgress =
	| { stage: 'idle' }
	| { stage: 'checking-binary' }
	| { stage: 'downloading-binary'; progress?: number }
	| { stage: 'binary-ready' }
	| { stage: 'starting-tunnel' }
	| { stage: 'generating-url' }
	| { stage: 'connected' }
	| { stage: 'failed'; error: string };

interface TunnelInfo {
	port: number;
	publicUrl: string;
	startedAt: string;
	autoStopMinutes: number;
}

interface PortState {
	isLoading: boolean;
	error: string | null;
	progress: TunnelProgress;
}

interface TunnelState {
	tunnels: TunnelInfo[];
	portStates: Record<number, PortState>;
}

// Tunnel store state
const tunnelState = $state<TunnelState>({
	tunnels: [],
	portStates: {}
});

export const tunnelStore = {
	get tunnels() {
		return tunnelState.tunnels;
	},
	isLoading(port: number) {
		return tunnelState.portStates[port]?.isLoading ?? false;
	},
	getError(port: number) {
		return tunnelState.portStates[port]?.error ?? null;
	},
	getProgress(port: number) {
		return tunnelState.portStates[port]?.progress ?? { stage: 'idle' };
	},
	getTunnel(port: number) {
		return tunnelState.tunnels.find((t) => t.port === port) || null;
	},

	/**
	 * Start tunnel globally
	 * Note: First time may take 30-90 seconds (downloading binary + starting tunnel)
	 */
	async startTunnel(port: number, autoStopMinutes?: number) {
		// Initialize port state
		tunnelState.portStates[port] = {
			isLoading: true,
			error: null,
			progress: { stage: 'starting-tunnel' }
		};

		debug.log('tunnel', `[Frontend] Starting tunnel for port ${port}...`);

		try {
			// Use HTTP pattern directly
			const result = await ws.http('tunnel:start', { port, autoStopMinutes });

			if (!result || !result.publicUrl) {
				throw new Error('No result received from server');
			}

			// Add tunnel to the list
			tunnelState.tunnels.push({
				port,
				publicUrl: result.publicUrl,
				startedAt: new Date().toISOString(),
				autoStopMinutes: autoStopMinutes || 60
			});

			tunnelState.portStates[port].progress = { stage: 'connected' };
			tunnelState.portStates[port].isLoading = false;

			debug.log('tunnel', `[Frontend] ✅ Tunnel started successfully on port ${port}:`, result.publicUrl);
			if (result.timings) {
				debug.log('tunnel', '[Frontend] Timings:', result.timings);
			}

			// Reset progress after a short delay
			setTimeout(() => {
				if (tunnelState.portStates[port]) {
					tunnelState.portStates[port].progress = { stage: 'idle' };
				}
			}, 1500);
		} catch (error) {
			if (error instanceof Error) {
				tunnelState.portStates[port].error = error.message;
				tunnelState.portStates[port].progress = { stage: 'failed', error: error.message };
				debug.error('tunnel', '[Frontend] Error:', error.message);
			} else {
				const errorMsg = 'Unknown error';
				tunnelState.portStates[port].error = errorMsg;
				tunnelState.portStates[port].progress = { stage: 'failed', error: errorMsg };
				debug.error('tunnel', '[Frontend] Unknown error:', error);
			}
			tunnelState.portStates[port].isLoading = false;
			throw error;
		}
	},

	/**
	 * Stop tunnel for a port
	 */
	async stopTunnel(port: number) {
		try {
			const response = await ws.http('tunnel:stop', { port });

			if (!response.stopped) {
				throw new Error('Failed to stop tunnel');
			}

			// Remove tunnel from the list
			tunnelState.tunnels = tunnelState.tunnels.filter((t) => t.port !== port);
			delete tunnelState.portStates[port];

			debug.log('tunnel', `Tunnel stopped on port ${port}`);
		} catch (error) {
			debug.error('tunnel', 'Failed to stop tunnel:', error);
			throw error;
		}
	},

	/**
	 * Check tunnel status globally
	 */
	async checkStatus() {
		try {
			const response = await ws.http('tunnel:status', {});

			// Update tunnels list from server
			tunnelState.tunnels = response.tunnels || [];
		} catch (error) {
			debug.error('tunnel', 'Failed to check tunnel status:', error);
		}
	},

	/**
	 * Reset tunnel state
	 */
	reset() {
		tunnelState.tunnels = [];
		tunnelState.portStates = {};
	}
};
