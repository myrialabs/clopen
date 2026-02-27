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

interface TunnelConnection {
	id: string;
	ip: string;
	location: string;
}

class ProjectTunnelManager {
	// Key format: "projectId:port" to support multiple tunnels per project
	private activeTunnels = new Map<string, TunnelInstance>();
	private binaryInstalled = false;

	/**
	 * Generate unique key for tunnel
	 */
	private getTunnelKey(projectId: string, port: number): string {
		return `${projectId}:${port}`;
	}

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
	 * Start cloudflared tunnel for a project port
	 */
	async startTunnel(
		projectId: string,
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
		const tunnelKey = this.getTunnelKey(projectId, port);
		if (this.activeTunnels.has(tunnelKey)) {
			throw new Error(`Tunnel already active for port ${port}`);
		}

		debug.log('tunnel', `[PROGRESS:STARTING_TUNNEL] Starting tunnel for project ${projectId} on port ${port}`);
		onProgress?.('starting-tunnel', { port });

		const tunnelStartTime = Date.now();

		// Create quick tunnel pointing to localhost:port
		// Use Tunnel.quick() method for quick tunnels
		const tunnel = Tunnel.quick(`http://localhost:${port}`);

		// Log ALL events for debugging
		tunnel.on('url', (url: string) => debug.log('tunnel', `[EVENT] url: ${url}`));
		tunnel.on('connected', (info: any) => debug.log('tunnel', `[EVENT] connected:`, info));
		tunnel.on('error', (error: Error) => debug.error('tunnel', `[EVENT] error:`, error));
		tunnel.on('exit', (code: number | null) => debug.log('tunnel', `[EVENT] exit with code ${code}`));
		tunnel.on('stdout', (data: string) => debug.log('tunnel', `[STDOUT] ${data.trim()}`));
		tunnel.on('stderr', (data: string) => debug.log('tunnel', `[STDERR] ${data.trim()}`));

		// Wait for URL to be generated
		debug.log('tunnel', '[PROGRESS:GENERATING_URL] Waiting for tunnel URL to be generated...');
		onProgress?.('generating-url');
		const urlGenerationStart = Date.now();

		const publicUrl = await new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				tunnel.stop();
				reject(
					new Error(
						'Tunnel URL generation timeout. Please check if port ' +
							port +
							' is accessible and has a running service.'
					)
				);
			}, 90000); // 90s timeout (first time may take longer)

			tunnel.on('url', (url: string) => {
				// Validate that this is an actual tunnel URL, not the API endpoint
				// Real tunnel URLs: https://random-words-1234.trycloudflare.com
				// API endpoint (invalid): https://api.trycloudflare.com
				if (url.includes('api.trycloudflare.com')) {
					debug.log('tunnel', `Ignoring API endpoint URL: ${url}`);
					return; // Ignore API endpoint, wait for real tunnel URL
				}

				clearTimeout(timeout);
				const urlGenerationTime = Date.now() - urlGenerationStart;
				timings.urlGeneration = urlGenerationTime;

				debug.log('tunnel', `[PROGRESS:CONNECTED] ✅ Tunnel URL generated in ${urlGenerationTime}ms: ${url}`);
				debug.log('tunnel', 'Tunnel is now ready to use!');
				onProgress?.('connected', { url, time: urlGenerationTime });
				resolve(url);
			});

			tunnel.once('error', (error: Error) => {
				clearTimeout(timeout);
				tunnel.stop();
				debug.error('tunnel', 'Tunnel error:', error);
				reject(error);
			});

			tunnel.once('exit', (code: number | null) => {
				if (code !== 0 && code !== null) {
					clearTimeout(timeout);
					debug.error('tunnel', `Tunnel exited with error code ${code}`);
					reject(
						new Error(
							`Tunnel failed to start (exit code ${code}). This might be a network/DNS issue. Please check your internet connection.`
						)
					);
				}
			});
		});

		// Log connection info when it arrives (non-blocking)
		// Note: We don't wait for 'connected' event because tunnel is already functional after URL is generated
		tunnel.once('connected', (info: TunnelConnection) => {
			debug.log('tunnel', `✅ Tunnel connected:`, info);
		});

		// Setup auto-stop timer
		const autoStopTimer = setTimeout(() => {
			debug.log('tunnel', `Auto-stopping tunnel for project ${projectId} on port ${port}`);
			this.stopTunnel(projectId, port);
		}, autoStopMinutes * 60 * 1000);

		// Handle tunnel exit
		tunnel.on('exit', (code: number | null) => {
			debug.log('tunnel', `Tunnel exited with code ${code}`);
			this.activeTunnels.delete(tunnelKey);
		});

		// Store tunnel instance
		this.activeTunnels.set(tunnelKey, {
			tunnel,
			publicUrl,
			localPort: port,
			startedAt: new Date(),
			autoStopTimer
		});

		const totalTime = Date.now() - tunnelStartTime;
		timings.total = totalTime;

		debug.log('tunnel', `[PROGRESS:COMPLETE] Tunnel setup completed in ${totalTime}ms`);

		return {
			publicUrl,
			status: 'active',
			binaryDownloaded: binaryInfo.needsDownload,
			timings
		};
	}

	/**
	 * Stop tunnel for a project port
	 */
	stopTunnel(projectId: string, port: number): void {
		const tunnelKey = this.getTunnelKey(projectId, port);
		const instance = this.activeTunnels.get(tunnelKey);

		// If tunnel is not found, it's already stopped - return success silently
		if (!instance) {
			debug.log('tunnel', `Tunnel for port ${port} is already stopped`);
			return;
		}

		debug.log('tunnel', `Stopping tunnel for project ${projectId} on port ${port}`);

		// Clear auto-stop timer
		if (instance.autoStopTimer) {
			clearTimeout(instance.autoStopTimer);
		}

		// Stop the tunnel
		instance.tunnel.stop();

		this.activeTunnels.delete(tunnelKey);
	}

	/**
	 * Get tunnel info for a project port
	 */
	getTunnelInfo(projectId: string, port: number): TunnelInstance | null {
		const tunnelKey = this.getTunnelKey(projectId, port);
		return this.activeTunnels.get(tunnelKey) || null;
	}

	/**
	 * Check if tunnel is active for a project port
	 */
	isActive(projectId: string, port: number): boolean {
		const tunnelKey = this.getTunnelKey(projectId, port);
		return this.activeTunnels.has(tunnelKey);
	}

	/**
	 * Get all active tunnels for a project
	 */
	getProjectTunnels(projectId: string): Array<TunnelInstance & { port: number }> {
		const tunnels: Array<TunnelInstance & { port: number }> = [];
		for (const [key, instance] of this.activeTunnels.entries()) {
			if (key.startsWith(`${projectId}:`)) {
				tunnels.push({ ...instance, port: instance.localPort });
			}
		}
		return tunnels;
	}

	/**
	 * Get all active tunnels
	 */
	getAllActiveTunnels(): Map<string, TunnelInstance> {
		return this.activeTunnels;
	}

	/**
	 * Cleanup all tunnels (on server shutdown)
	 */
	cleanup(): void {
		debug.log('tunnel', 'Cleaning up all active tunnels');
		for (const [key, instance] of this.activeTunnels) {
			const [projectId, portStr] = key.split(':');
			const port = parseInt(portStr, 10);
			this.stopTunnel(projectId, port);
		}
	}
}

// Singleton instance
export const projectTunnelManager = new ProjectTunnelManager();

// Cleanup on process exit
process.on('exit', () => {
	projectTunnelManager.cleanup();
});

process.on('SIGINT', () => {
	projectTunnelManager.cleanup();
	process.exit(0);
});
