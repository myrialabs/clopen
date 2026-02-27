/**
 * Browser Video Capture Handler
 *
 * Handles WebCodecs-based video streaming with WebRTC DataChannel transport.
 *
 * Video Architecture:
 * 1. Puppeteer CDP captures JPEG frames via Page.screencastFrame
 * 2. Decode JPEG to ImageBitmap in browser
 * 3. Encode with VideoEncoder (VP8) in browser
 * 4. Send encoded chunks via RTCDataChannel
 *
 * Audio Architecture:
 * 1. AudioContext interception (handled by BrowserAudioCapture)
 * 2. Audio encoded with AudioEncoder (Opus) in headless browser
 * 3. Encoded chunks sent via sendAudioChunk() to same DataChannel
 *
 * Client:
 * - Receives video + audio chunks via DataChannel
 * - Decodes with VideoDecoder + AudioDecoder
 * - Renders video to canvas, plays audio with proper scheduling
 *
 * Benefits vs Canvas + WebRTC:
 * - Lower bandwidth (500-800 Kbps vs 1 Mbps)
 * - More control over codec selection
 * - Skip canvas rendering overhead
 * - DataChannel = lower latency than video track
 */

import { EventEmitter } from 'events';
import type { Page } from 'puppeteer';
import type { BrowserTab, StreamingConfig } from './types';
import { DEFAULT_STREAMING_CONFIG } from './types';
import { videoEncoderScript } from './scripts/video-stream';
import { debug } from '$shared/utils/logger';

interface VideoStreamSession {
	sessionId: string;
	isActive: boolean;
	clientConnected: boolean;
	headlessReady: boolean;
	pendingCandidates: RTCIceCandidateInit[];
	scriptInjected: boolean; // Track if persistent script was injected
	stats: {
		videoBytesSent: number;
		audioBytesSent: number;
		videoFramesEncoded: number;
		audioFramesEncoded: number;
		connectionState: string;
	};
}

export class BrowserVideoCapture extends EventEmitter {
	private sessions = new Map<string, VideoStreamSession>();

	constructor() {
		super();
	}

	/**
	 * Start video streaming for a session
	 */
	async startStreaming(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean
	): Promise<boolean> {
		debug.log('webcodecs', `Starting streaming for session ${sessionId}`);

		// If session exists, stop it first
		if (this.sessions.has(sessionId)) {
			debug.log('webcodecs', `Session ${sessionId} exists, stopping for restart`);
			await this.stopStreaming(sessionId, session);
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		if (!session.page || session.page.isClosed()) {
			debug.error('webcodecs', `Cannot start: page is closed`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;

			// Get scale from session (default to 1 if not set)
			const scale = session.scale || 1;
			debug.log('webcodecs', `Using scale: ${scale} for session ${sessionId}`);

			// Get or create session tracking
			let videoSession = this.sessions.get(sessionId);
			const isRestart = !!videoSession;

			if (!videoSession) {
				videoSession = {
					sessionId,
					isActive: false,
					clientConnected: false,
					headlessReady: false,
					pendingCandidates: [],
					scriptInjected: false,
					stats: {
						videoBytesSent: 0,
						audioBytesSent: 0,
						videoFramesEncoded: 0,
						audioFramesEncoded: 0,
						connectionState: 'new'
					}
				};
				this.sessions.set(sessionId, videoSession);
			}

			// Check if bindings exist
			const bindingsExist = await page.evaluate(() => {
				return typeof (window as any).__sendIceCandidate === 'function';
			});

			// Expose signaling functions (persists across navigations)
			if (!bindingsExist) {
				await page.exposeFunction('__sendIceCandidate', (candidate: RTCIceCandidateInit) => {
					const activeSession = Array.from(this.sessions.values()).find(s => s.isActive);
					if (!activeSession) return;
					this.emit('ice-candidate', { sessionId: activeSession.sessionId, candidate, from: 'headless' });
				});

				await page.exposeFunction('__sendConnectionState', (state: string) => {
					const activeSession = Array.from(this.sessions.values()).find(s => s.isActive);
					if (activeSession) {
						activeSession.stats.connectionState = state;
						this.emit('connection-state', { sessionId: activeSession.sessionId, state });
					}
				});

				await page.exposeFunction('__sendCursorChange', (cursor: string) => {
					const activeSession = Array.from(this.sessions.values()).find(s => s.isActive);
					if (activeSession) {
						this.emit('cursor-change', { sessionId: activeSession.sessionId, cursor });
					}
				});
			}

			// Calculate scaled dimensions
			const scaledWidth = Math.round(viewport.width * scale);
			const scaledHeight = Math.round(viewport.height * scale);

			const videoConfig: StreamingConfig['video'] = {
				...config.video,
				width: scaledWidth,
				height: scaledHeight
			};

			// Store config globally for persistent script access
			await page.evaluate((cfg) => {
				(window as any).__videoEncoderConfig = cfg;
			}, videoConfig);

			// Inject persistent video encoder script (survives navigation)
			// Only inject once per page instance
			if (!videoSession.scriptInjected) {
				await page.evaluateOnNewDocument(videoEncoderScript, videoConfig);
				videoSession.scriptInjected = true;
				debug.log('webcodecs', `Persistent video encoder script injected for ${sessionId}`);
			}

			// Also inject immediately for current page context
			// (evaluateOnNewDocument only runs on NEXT navigation)
			await page.evaluate(videoEncoderScript, videoConfig);

			// Verify peer was created
			const peerExists = await page.evaluate(() => {
				return typeof (window as any).__webCodecsPeer?.startStreaming === 'function';
			});

			if (!peerExists) {
				debug.error('webcodecs', `Peer script injected but __webCodecsPeer not available`);
				this.sessions.delete(sessionId);
				return false;
			}

			videoSession.isActive = true;

			// Wait for page to be fully loaded
			try {
				const loadState = await page.evaluate(() => document.readyState);
				if (loadState !== 'complete') {
					debug.log('webcodecs', `Waiting for page load...`);
					await page.waitForFunction(() => document.readyState === 'complete', { timeout: 60000 });
				}
			} catch (loadError) {
				debug.warn('webcodecs', 'Page load wait timed out, proceeding anyway');
			}

			// Start video streaming
			const started = await page.evaluate(() => {
				return (window as any).__webCodecsPeer?.startStreaming();
			});

			if (!started) {
				debug.error('webcodecs', `startStreaming returned false`);
				this.sessions.delete(sessionId);
				return false;
			}

			// Initialize and start audio encoder (from AudioContext interception)
			const audioEncoderAvailable = await page.evaluate(() => {
				return typeof (window as any).__audioEncoder?.init === 'function';
			});

			if (audioEncoderAvailable) {
				debug.log('webcodecs', 'Initializing audio encoder from AudioContext interception...');

				const audioInitialized = await page.evaluate(async () => {
					const encoder = (window as any).__audioEncoder;
					if (!encoder) return false;

					const initiated = await encoder.init();
					if (initiated) {
						return encoder.start();
					}
					return false;
				});

				if (audioInitialized) {
					debug.log('webcodecs', 'Audio encoder initialized and started');
				} else {
					debug.warn('webcodecs', 'Audio encoder initialization failed, continuing with video only');
				}
			} else {
				debug.warn('webcodecs', 'Audio encoder not available (AudioEncoder API may not be supported)');
			}

			videoSession.headlessReady = true;

			// Setup CDP screencast to feed frames to encoder
			await this.setupFrameFeeder(sessionId, session, config, isValidSession);

			debug.log('webcodecs', `Streaming started for ${sessionId}`);
			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to start streaming:`, error);
			this.sessions.delete(sessionId);
			throw error;
		}
	}

	/**
	 * Setup CDP screencast to feed JPEG frames to VideoEncoder
	 */
	private async setupFrameFeeder(
		sessionId: string,
		session: BrowserTab,
		config: StreamingConfig,
		isValidSession: () => boolean
	): Promise<void> {
		const page = session.page;
		const viewport = page.viewport()!;

		// Get scale from session (default to 1 if not set)
		const scale = session.scale || 1;

		const cdp = await page.createCDPSession();

		let cdpFrameCount = 0;

		cdp.on('Page.screencastFrame', async (event: any) => {
			cdpFrameCount++;

			const videoSession = this.sessions.get(sessionId);
			if (!videoSession?.isActive || session.isDestroyed) {
				cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
				return;
			}

			if (!isValidSession()) {
				this.stopStreaming(sessionId);
				return;
			}

			// ACK immediately
			cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});

			// Send frame to encoder
			page.evaluate((frameData) => {
				const peer = (window as any).__webCodecsPeer;
				if (!peer) return false;
				peer.encodeFrame(frameData);
				return true;
			}, event.data).catch((err) => {
				if (cdpFrameCount <= 5) {
					debug.warn('webcodecs', `Frame delivery error (frame ${cdpFrameCount}):`, err.message);
				}
			});
		});

		// Start screencast with scaled dimensions
		const scaledWidth = Math.round(viewport.width * scale);
		const scaledHeight = Math.round(viewport.height * scale);

		await cdp.send('Page.startScreencast', {
			format: 'jpeg',
			quality: config.video.screenshotQuality,
			maxWidth: scaledWidth,
			maxHeight: scaledHeight,
			everyNthFrame: 1
		});

		debug.log('webcodecs', `CDP screencast started with scaled dimensions: ${scaledWidth}x${scaledHeight} (scale: ${scale})`);
		(session as any).__webCodecsCdp = cdp;
	}

	/**
	 * Create offer from headless browser
	 */
	async createOffer(sessionId: string, session: BrowserTab): Promise<RTCSessionDescriptionInit | null> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return null;
		}

		const maxRetries = 5;
		const retryDelay = 100;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const peerReady = await session.page.evaluate(() => {
					return typeof (window as any).__webCodecsPeer?.createOffer === 'function';
				});

				if (!peerReady) {
					if (attempt < maxRetries - 1) {
						await new Promise(resolve => setTimeout(resolve, retryDelay));
						continue;
					}
					return null;
				}

				const offer = await session.page.evaluate(() => {
					return (window as any).__webCodecsPeer?.createOffer();
				});

				if (offer) return offer;

				if (attempt < maxRetries - 1) {
					await new Promise(resolve => setTimeout(resolve, retryDelay));
				}
			} catch (error) {
				debug.error('webcodecs', `Create offer error (attempt ${attempt + 1}):`, error);
				if (attempt < maxRetries - 1) {
					await new Promise(resolve => setTimeout(resolve, retryDelay));
				}
			}
		}

		return null;
	}

	/**
	 * Handle answer from client
	 */
	async handleAnswer(
		sessionId: string,
		session: BrowserTab,
		answer: RTCSessionDescriptionInit
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return false;
		}

		try {
			const success = await session.page.evaluate((ans) => {
				return (window as any).__webCodecsPeer?.handleAnswer(ans);
			}, answer);

			if (success) {
				videoSession.clientConnected = true;

				// Process pending ICE candidates
				for (const candidate of videoSession.pendingCandidates) {
					await this.addIceCandidate(sessionId, session, candidate);
				}
				videoSession.pendingCandidates = [];
			}

			return success;
		} catch (error) {
			debug.error('webcodecs', `Handle answer error:`, error);
			return false;
		}
	}

	/**
	 * Add ICE candidate from client
	 */
	async addIceCandidate(
		sessionId: string,
		session: BrowserTab,
		candidate: RTCIceCandidateInit
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return false;
		}

		// Queue if not connected yet
		if (!videoSession.clientConnected) {
			videoSession.pendingCandidates.push(candidate);
			return true;
		}

		try {
			return await session.page.evaluate((cand) => {
				return (window as any).__webCodecsPeer?.addIceCandidate(cand);
			}, candidate);
		} catch (error) {
			debug.error('webcodecs', `Add ICE candidate error:`, error);
			return false;
		}
	}

	/**
	 * Update viewport and scale without reconnection (hot-swap)
	 */
	async updateViewport(sessionId: string, session: BrowserTab, width: number, height: number, newScale: number): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot update viewport: session not active`);
			return false;
		}

		try {
			const page = session.page;
			const config = DEFAULT_STREAMING_CONFIG;

			// Calculate scaled dimensions
			const scaledWidth = Math.round(width * newScale);
			const scaledHeight = Math.round(height * newScale);

			debug.log('webcodecs', `🔄 Hot-swapping viewport to ${width}x${height} (scaled: ${scaledWidth}x${scaledHeight}, scale: ${newScale})`);

			// Step 1: Update viewport via CDP (without page reload)
			await page.setViewport({ width, height });

			// Step 2: Reconfigure VideoEncoder with scaled dimensions
			const reconfigured = await page.evaluate((dimensions) => {
				const peer = (window as any).__webCodecsPeer;
				if (!peer || !peer.reconfigureEncoder) return false;
				return peer.reconfigureEncoder(dimensions.width, dimensions.height);
			}, { width: scaledWidth, height: scaledHeight });

			if (!reconfigured) {
				debug.error('webcodecs', `Failed to reconfigure encoder`);
				return false;
			}

			// Step 3: Restart CDP screencast with new dimensions
			const cdp = (session as any).__webCodecsCdp;
			if (cdp) {
				await cdp.send('Page.stopScreencast').catch(() => {});
				await cdp.send('Page.startScreencast', {
					format: 'jpeg',
					quality: config.video.screenshotQuality,
					maxWidth: scaledWidth,
					maxHeight: scaledHeight,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Viewport hot-swapped successfully to ${width}x${height} (scale: ${newScale})`);
			}

			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to update viewport:`, error);
			return false;
		}
	}

	/**
	 * Update scale without reconnection (hot-swap)
	 */
	async updateScale(sessionId: string, session: BrowserTab, newScale: number): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot update scale: session not active`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;

			// Calculate new scaled dimensions
			const scaledWidth = Math.round(viewport.width * newScale);
			const scaledHeight = Math.round(viewport.height * newScale);

			debug.log('webcodecs', `🔄 Hot-swapping resolution to ${scaledWidth}x${scaledHeight} (scale: ${newScale})`);

			// Step 1: Reconfigure VideoEncoder in headless browser
			const reconfigured = await page.evaluate((dimensions) => {
				const peer = (window as any).__webCodecsPeer;
				if (!peer || !peer.reconfigureEncoder) return false;
				return peer.reconfigureEncoder(dimensions.width, dimensions.height);
			}, { width: scaledWidth, height: scaledHeight });

			if (!reconfigured) {
				debug.error('webcodecs', `Failed to reconfigure encoder`);
				return false;
			}

			// Step 2: Restart CDP screencast with new dimensions
			const cdp = (session as any).__webCodecsCdp;
			if (cdp) {
				// Stop current screencast
				await cdp.send('Page.stopScreencast').catch(() => {});

				// Start with new dimensions
				await cdp.send('Page.startScreencast', {
					format: 'jpeg',
					quality: config.video.screenshotQuality,
					maxWidth: scaledWidth,
					maxHeight: scaledHeight,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Scale hot-swapped successfully to ${scaledWidth}x${scaledHeight}`);
			}

			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to update scale:`, error);
			return false;
		}
	}

	/**
	 * Handle navigation - re-inject peer script and restart CDP screencast
	 * Called after page navigation to restore video streaming without full reconnection
	 */
	async handleNavigation(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot handle navigation: session not active`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;
			const scale = session.scale || 1;

			debug.log('webcodecs', `🔄 Handling navigation for ${sessionId} - re-injecting peer script and restarting screencast`);

			// Calculate scaled dimensions
			const scaledWidth = Math.round(viewport.width * scale);
			const scaledHeight = Math.round(viewport.height * scale);

			const videoConfig: StreamingConfig['video'] = {
				...config.video,
				width: scaledWidth,
				height: scaledHeight
			};

			// Re-inject video encoder script to new page context
			// (evaluateOnNewDocument doesn't run for the current navigation, only future ones)
			await page.evaluate((cfg) => {
				(window as any).__videoEncoderConfig = cfg;
			}, videoConfig);

			await page.evaluate(videoEncoderScript, videoConfig);

			// Verify peer was re-created
			const peerExists = await page.evaluate(() => {
				return typeof (window as any).__webCodecsPeer?.startStreaming === 'function';
			});

			if (!peerExists) {
				debug.error('webcodecs', `Peer script re-injection failed - peer not available`);
				return false;
			}

			// Start video streaming on new page
			const started = await page.evaluate(() => {
				return (window as any).__webCodecsPeer?.startStreaming();
			});

			if (!started) {
				debug.error('webcodecs', `Failed to start streaming on new page`);
				return false;
			}

			// Restart CDP screencast
			const cdp = (session as any).__webCodecsCdp;
			if (cdp) {
				// Stop current screencast
				await cdp.send('Page.stopScreencast').catch(() => {});

				// Start with current dimensions
				await cdp.send('Page.startScreencast', {
					format: 'jpeg',
					quality: config.video.screenshotQuality,
					maxWidth: scaledWidth,
					maxHeight: scaledHeight,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Navigation handled - screencast restarted at ${scaledWidth}x${scaledHeight}`);
			}

			// Emit event to notify frontend that streaming is ready
			this.emit('navigation-streaming-ready', { sessionId });

			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to handle navigation:`, error);
			return false;
		}
	}

	/**
	 * Stop video streaming
	 */
	async stopStreaming(sessionId: string, session?: BrowserTab): Promise<void> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession) return;

		debug.log('webcodecs', `Stopping streaming for ${sessionId}`);

		videoSession.isActive = false;

		if (session?.page && !session.page.isClosed()) {
			try {
				// Stop peer
				await session.page.evaluate(() => {
					(window as any).__webCodecsPeer?.stopStreaming();
				});

				// Stop CDP screencast
				const cdp = (session as any).__webCodecsCdp;
				if (cdp) {
					await cdp.send('Page.stopScreencast').catch(() => {});
					await cdp.detach().catch(() => {});
					(session as any).__webCodecsCdp = null;
				}
			} catch (error) {
				debug.warn('webcodecs', `Error during cleanup: ${error}`);
			}
		}

		this.sessions.delete(sessionId);
	}

	/**
	 * Check if streaming is active
	 */
	isStreaming(sessionId: string): boolean {
		return this.sessions.get(sessionId)?.isActive ?? false;
	}

	/**
	 * Get session stats
	 */
	async getStats(sessionId: string, session: BrowserTab): Promise<VideoStreamSession['stats'] | null> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return videoSession?.stats || null;
		}

		try {
			const stats = await session.page.evaluate(() => {
				return (window as any).__webCodecsPeer?.getStats();
			});

			if (stats) {
				videoSession.stats = stats;
			}
			return videoSession.stats;
		} catch (error) {
			return videoSession.stats;
		}
	}

	/**
	 * Cleanup all sessions
	 */
	async cleanup(): Promise<void> {
		debug.log('webcodecs', 'Cleaning up all sessions');

		const sessionIds = Array.from(this.sessions.keys());
		await Promise.all(sessionIds.map((id) => this.stopStreaming(id)));

		this.sessions.clear();
	}
}
