import { Tunnel, bin, install } from 'cloudflared';
import { debug } from '$shared/utils/logger';
import { existsSync } from 'fs';

interface TunnelInstance {
	tunnel: any;
	publicUrl: string;
	localPort: number;
	startedAt: Date;
	autoStopTimer?: NodeJS.Timeout;
}

class GlobalTunnelManager {
	// Key format: "port" for global tunnels
	private activeTunnels = new Map<number, TunnelInstance>();
	private binaryInstalled = false;

	/**
	 * Ensure cloudflared binary is installed
	 * Downloads binary on first use (~66MB, takes 30-60 seconds)
	 */
	private async ensureBinaryInstalled(
		onProgress?: (stage: string, data?: any) => void
	): Promise<{
		needsDownload: boolean;
		downloadTime?: number;
	}> {
		// Check if already verified in this session
		if (this.binaryInstalled) {
			onProgress?.('binary-ready', { cached: true });
			return { needsDownload: false };
		}

		// Check if binary file exists
		if (!existsSync(bin)) {
			debug.log('tunnel', '[PROGRESS:DOWNLOADING_BINARY] Cloudflared binary not found, downloading...');
			debug.log('tunnel', 'This may take 30-60 seconds on first use (downloading ~66MB)');
			onProgress?.('downloading-binary', { size: '~66MB' });

			const startTime = Date.now();

			try {
				// Call install() from cloudflared package
				// This downloads the binary from Cloudflare's CDN
				await install(bin);

				const downloadTime = Date.now() - startTime;
				debug.log('tunnel', `[PROGRESS:BINARY_READY] Cloudflared binary installed successfully in ${downloadTime}ms at: ${bin}`);

				// Verify the binary was actually created
				if (!existsSync(bin)) {
					throw new Error('Binary file was not created after installation');
				}

				this.binaryInstalled = true;
				onProgress?.('binary-ready', { downloaded: true, time: downloadTime });
				return { needsDownload: true, downloadTime };
			} catch (error) {
				debug.error('tunnel', 'Failed to install cloudflared binary:', error);
				throw new Error(
					'Failed to download cloudflared binary. Please check your internet connection and try again. ' +
						'The tunnel feature requires downloading ~66MB on first use.'
				);
			}
		} else {
			debug.log('tunnel', '[PROGRESS:BINARY_READY] Cloudflared binary already installed at:', bin);
			this.binaryInstalled = true;
			onProgress?.('binary-ready', { cached: true });
			return { needsDownload: false };
		}
	}

	/**
	 * Start cloudflared tunnel for a port
	 */
	async startTunnel(
		port: number,
		autoStopMinutes: number = 60,
		onProgress?: (stage: string, data?: any) => void
	): Promise<{ publicUrl: string; status: 'active'; binaryDownloaded: boolean; timings: any }> {
		debug.log('tunnel', '[PROGRESS:CHECKING_BINARY] Checking if binary is installed...');
		onProgress?.('checking-binary');

		// Ensure binary is installed
		const binaryInfo = await this.ensureBinaryInstalled(onProgress);
		const timings: any = {};

		if (binaryInfo.needsDownload) {
			timings.binaryDownload = binaryInfo.downloadTime;
		}

		// Check if tunnel already exists for this port
		if (this.activeTunnels.has(port)) {
			const existing = this.activeTunnels.get(port)!;
			debug.log('tunnel', `Tunnel already exists for port ${port}, returning existing URL`);
			return {
				publicUrl: existing.publicUrl,
				status: 'active',
				binaryDownloaded: binaryInfo.needsDownload,
				timings
			};
		}

		debug.log('tunnel', `[PROGRESS:STARTING_TUNNEL] Starting cloudflared tunnel for port ${port}...`);
		onProgress?.('starting-tunnel', { port });

		const tunnelStartTime = Date.now();

		try {
			// Create tunnel instance
			const tunnel = new Tunnel({
				// Bind to specific port
				url: `http://localhost:${port}`
			});

			// Wait for tunnel to be ready
			debug.log('tunnel', '[PROGRESS:GENERATING_URL] Waiting for public URL...');
			onProgress?.('generating-url');

			const publicUrl: string = await new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error('Tunnel connection timeout (30s)'));
				}, 30000); // 30 second timeout

				tunnel.on('url', (url: string) => {
					debug.log('tunnel', `[PROGRESS:CONNECTED] ✅ Tunnel connected! Public URL: ${url}`);
					clearTimeout(timeout);
					resolve(url);
				});

				tunnel.on('error', (error: Error) => {
					debug.error('tunnel', '[PROGRESS:FAILED] Tunnel error:', error);
					clearTimeout(timeout);
					reject(error);
				});
			});

			timings.tunnelStart = Date.now() - tunnelStartTime;
			timings.total = Date.now() - tunnelStartTime + (binaryInfo.downloadTime || 0);

			// Setup auto-stop timer
			const autoStopMs = autoStopMinutes * 60 * 1000;
			const autoStopTimer = setTimeout(
				() => {
					debug.log('tunnel', `Auto-stopping tunnel on port ${port} after ${autoStopMinutes} minutes`);
					this.stopTunnel(port);
				},
				autoStopMs
			);

			// Store tunnel instance
			const instance: TunnelInstance = {
				tunnel,
				publicUrl,
				localPort: port,
				startedAt: new Date(),
				autoStopTimer
			};

			this.activeTunnels.set(port, instance);

			debug.log('tunnel', `✅ Tunnel started successfully on port ${port}`);
			debug.log('tunnel', `   Public URL: ${publicUrl}`);
			debug.log('tunnel', `   Auto-stop: ${autoStopMinutes} minutes`);
			debug.log('tunnel', `   Timings:`, timings);
			onProgress?.('connected', { publicUrl, timings });

			return {
				publicUrl,
				status: 'active',
				binaryDownloaded: binaryInfo.needsDownload,
				timings
			};
		} catch (error) {
			debug.error('tunnel', `Failed to start tunnel on port ${port}:`, error);
			throw error;
		}
	}

	/**
	 * Stop tunnel for a port
	 */
	async stopTunnel(port: number): Promise<void> {
		const instance = this.activeTunnels.get(port);

		if (!instance) {
			debug.log('tunnel', `No active tunnel found for port ${port}`);
			return;
		}

		debug.log('tunnel', `Stopping tunnel on port ${port}...`);

		try {
			// Clear auto-stop timer
			if (instance.autoStopTimer) {
				clearTimeout(instance.autoStopTimer);
			}

			// Stop tunnel
			if (instance.tunnel && typeof instance.tunnel.stop === 'function') {
				await instance.tunnel.stop();
			}

			// Remove from active tunnels
			this.activeTunnels.delete(port);

			debug.log('tunnel', `✅ Tunnel stopped on port ${port}`);
		} catch (error) {
			debug.error('tunnel', `Error stopping tunnel on port ${port}:`, error);
			// Still remove from active tunnels even if stop failed
			this.activeTunnels.delete(port);
			throw error;
		}
	}

	/**
	 * Get all active tunnels
	 */
	getActiveTunnels(): Array<{
		port: number;
		publicUrl: string;
		startedAt: string;
	}> {
		return Array.from(this.activeTunnels.entries()).map(([port, instance]) => ({
			port,
			publicUrl: instance.publicUrl,
			startedAt: instance.startedAt.toISOString()
		}));
	}

	/**
	 * Stop all tunnels
	 */
	async stopAllTunnels(): Promise<void> {
		debug.log('tunnel', 'Stopping all tunnels...');
		const ports = Array.from(this.activeTunnels.keys());
		await Promise.all(ports.map((port) => this.stopTunnel(port)));
		debug.log('tunnel', '✅ All tunnels stopped');
	}
}

// Singleton instance
export const globalTunnelManager = new GlobalTunnelManager();
