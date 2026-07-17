/**
 * Browser Video Capture Handler
 *
 * Handles WebCodecs-based video streaming with WebRTC DataChannel transport.
 *
 * Video Architecture (Chrome-Remote-Desktop-style adaptive quality):
 * 1. CDP captures JPEG frames via Page.screencastFrame at native viewport resolution
 * 2. Direct CDP Runtime.evaluate sends base64 to page (bypasses Puppeteer IPC)
 * 3. Page decodes via createImageBitmap, encodes with VideoEncoder —
 *    preferred VP9 quantizer mode (cheap during motion), VP8 bitrate fallback
 * 4. When the page goes still, a lossless PNG screenshot is pushed through the
 *    encoder near-losslessly (top-off) so text sharpens after motion stops
 * 5. Send encoded chunks via reliable ordered RTCDataChannel; latency is
 *    bounded by source-side frame dropping (bufferedAmount backpressure)
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
import { audioCaptureScript } from './scripts/audio-stream';
import { debug } from '$shared/utils/logger';

interface VideoStreamSession {
	sessionId: string;
	isActive: boolean;
	clientConnected: boolean;
	headlessReady: boolean;
	pendingCandidates: RTCIceCandidateInit[];
	scriptInjected: boolean; // Track if persistent script was injected
	scriptsPreInjected: boolean; // Track if scripts were pre-injected during tab creation
	audioOnNewDocumentInjected: boolean; // Track if evaluateOnNewDocument was registered for audio
	allowVp9: boolean; // Client decode capability (negotiated at stream start)
	stats: {
		videoBytesSent: number;
		audioBytesSent: number;
		videoFramesEncoded: number;
		audioFramesEncoded: number;
		connectionState: string;
	};
}

/**
 * Scale encoder bitrate with capture resolution to keep bits-per-pixel
 * constant. Capture always runs at native viewport size (display fit-scale
 * is a CSS-only concern on the frontend), so a fixed bitrate would starve
 * larger viewports during motion.
 * 0.045 bpp at 1280×800@24fps ≈ 1.1 Mbps (comparable to the previous fixed 1 Mbps).
 */
const BITS_PER_PIXEL = 0.045;

function computeBitrate(width: number, height: number, framerate: number): number {
	return Math.max(
		DEFAULT_STREAMING_CONFIG.video.bitrate,
		Math.round(width * height * framerate * BITS_PER_PIXEL)
	);
}

export class BrowserVideoCapture extends EventEmitter {
	/**
	 * How long the screencast must be silent (no damage → no frames) before
	 * the page is considered still and a near-lossless top-off frame is sent.
	 * Long enough to skip inter-frame gaps of animations, short enough that
	 * text sharpens almost immediately after scrolling stops.
	 */
	private static readonly TOP_OFF_DELAY_MS = 300;

	private sessions = new Map<string, VideoStreamSession>();
	private preInjectPromises = new Map<string, Promise<boolean>>();

	constructor() {
		super();
	}

	/**
	 * Pre-inject WebCodecs scripts during tab creation.
	 * This overlaps script injection with frontend processing,
	 * so startStreaming() only needs batched init + CDP setup (~50-80ms).
	 */
	preInjectScripts(sessionId: string, session: BrowserTab): Promise<boolean> {
		const promise = this.doPreInject(sessionId, session);
		this.preInjectPromises.set(sessionId, promise);
		return promise;
	}

	private async doPreInject(sessionId: string, session: BrowserTab): Promise<boolean> {
		if (!session.page || session.page.isClosed()) return false;

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;

			// Capture at native viewport resolution. Capturing below viewport
			// size (old behavior: viewport × display fit-scale) forced the
			// client to upscale frames, which made the preview blurry.
			const videoConfig: StreamingConfig['video'] = {
				...config.video,
				width: viewport.width,
				height: viewport.height,
				bitrate: computeBitrate(viewport.width, viewport.height, config.video.framerate)
			};

			// Create session tracking
			const videoSession: VideoStreamSession = {
				sessionId,
				isActive: false,
				clientConnected: false,
				headlessReady: false,
				pendingCandidates: [],
				scriptInjected: true,
				scriptsPreInjected: false, // Set to true only after injection completes
				audioOnNewDocumentInjected: false,
				allowVp9: true,
				stats: {
					videoBytesSent: 0,
					audioBytesSent: 0,
					videoFramesEncoded: 0,
					audioFramesEncoded: 0,
					connectionState: 'new'
				}
			};
			this.sessions.set(sessionId, videoSession);

			await this.injectScripts(sessionId, page, videoConfig, config);

			// Mark as pre-injected only after successful completion
			videoSession.scriptsPreInjected = true;

			debug.log('webcodecs', `Pre-injected scripts for ${sessionId}`);
			return true;
		} catch (error) {
			debug.warn('webcodecs', `Pre-injection failed for ${sessionId}:`, error);
			// Clean up so startStreaming() will do full injection
			this.sessions.delete(sessionId);
			return false;
		} finally {
			this.preInjectPromises.delete(sessionId);
		}
	}

	/**
	 * Inject signaling bindings + encoder scripts into page
	 */
	private async injectScripts(
		sessionId: string,
		page: Page,
		videoConfig: StreamingConfig['video'],
		config: StreamingConfig
	): Promise<void> {
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

		// Register audio capture as a startup script — runs before page scripts on every new document load.
		// Critical for SPAs that create AudioContext during initialization (before page.evaluate runs).
		// The idempotency guard in audioCaptureScript prevents double-injection.
		const session = this.sessions.get(sessionId);
		if (session && !session.audioOnNewDocumentInjected) {
			await page.evaluateOnNewDocument(audioCaptureScript, config.audio);
			session.audioOnNewDocumentInjected = true;
		}

		// Inject video encoder + audio capture scripts into the current page context
		await page.evaluate(videoEncoderScript, videoConfig);
		await page.evaluate(audioCaptureScript, config.audio);
	}

	/**
	 * Start video streaming for a session
	 */
	async startStreaming(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean,
		allowVp9 = true
	): Promise<boolean> {
		debug.log('webcodecs', `Starting streaming for session ${sessionId} (client vp9: ${allowVp9})`);

		// Wait for any pending pre-injection to complete
		const pendingPreInject = this.preInjectPromises.get(sessionId);
		if (pendingPreInject) {
			debug.log('webcodecs', `Waiting for pre-injection to complete for ${sessionId}`);
			await pendingPreInject.catch(() => {});
		}

		// If session is already actively streaming, stop it for a clean reconnect.
		// This ensures the old PeerConnection + DataChannel are torn down and
		// a fresh one is created, preventing stale connections where no frames flow.
		const existingSession = this.sessions.get(sessionId);
		if (existingSession && existingSession.isActive) {
			debug.log('webcodecs', `Session ${sessionId} already active, stopping for clean reconnect`);
			await this.stopStreaming(sessionId, session);
		}

		if (!session.page || session.page.isClosed()) {
			debug.error('webcodecs', `Cannot start: page is closed`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;

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
					scriptsPreInjected: false,
					audioOnNewDocumentInjected: false,
					allowVp9,
					stats: {
						videoBytesSent: 0,
						audioBytesSent: 0,
						videoFramesEncoded: 0,
						audioFramesEncoded: 0,
						connectionState: 'new'
					}
				};
				this.sessions.set(sessionId, videoSession);
			} else {
				videoSession.allowVp9 = allowVp9;
			}

			// Capture at native viewport resolution (see doPreInject)
			const videoConfig: StreamingConfig['video'] = {
				...config.video,
				width: viewport.width,
				height: viewport.height,
				bitrate: computeBitrate(viewport.width, viewport.height, config.video.framerate)
			};

			// Skip script injection if already pre-injected during tab creation
			if (!videoSession.scriptsPreInjected) {
				await this.injectScripts(sessionId, page, videoConfig, config);
				videoSession.scriptInjected = true;
			} else {
				debug.log('webcodecs', `Scripts already pre-injected for ${sessionId}, skipping injection`);
			}

			// Single batched call: verify peer + start streaming + init audio
			// (saves ~60ms of IPC overhead vs 4 separate page.evaluate calls)
			const initResult = await page.evaluate(async (clientAllowsVp9) => {
				const peer = (window as any).__webCodecsPeer;
				if (typeof peer?.startStreaming !== 'function') {
					return { peerExists: false, started: false, audioInitialized: false };
				}

				const started = await peer.startStreaming(clientAllowsVp9);
				if (!started) {
					return { peerExists: true, started: false, audioInitialized: false };
				}

				// Initialize audio encoder if available
				let audioInitialized = false;
				const encoder = (window as any).__audioEncoder;
				if (typeof encoder?.init === 'function') {
					try {
						const initiated = await encoder.init();
						if (initiated) {
							audioInitialized = !!encoder.start();
						}
					} catch {}
				}

				return { peerExists: true, started: true, audioInitialized };
			}, allowVp9);

			if (!initResult.peerExists) {
				debug.error('webcodecs', `Peer script injected but __webCodecsPeer not available`);
				this.sessions.delete(sessionId);
				return false;
			}

			if (!initResult.started) {
				debug.error('webcodecs', `startStreaming returned false`);
				this.sessions.delete(sessionId);
				return false;
			}

			videoSession.isActive = true;

			if (initResult.audioInitialized) {
				debug.log('webcodecs', 'Audio encoder initialized and started');
			} else {
				debug.warn('webcodecs', 'Audio not available, continuing with video only');
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

		const cdp = await page.createCDPSession();

		let cdpFrameCount = 0;

		// Rate-limit encoding to the configured framerate. CDP screencast fires
		// at compositor rate (up to 60fps) — encoding every frame wastes CPU on
		// the host and bandwidth on the wire without visible benefit.
		//
		// Trailing edge matters: the LAST frame of a burst must always be
		// encoded. Plain dropping left a stale frame on screen until the
		// top-off fired (~300ms later), which felt like input lag on every
		// click/keystroke.
		const minFrameIntervalMs = Math.floor(1000 / config.video.framerate);
		let lastEncodeTime = 0;
		let pendingFrameData: string | null = null;
		let pendingFrameTimer: ReturnType<typeof setTimeout> | null = null;

		const encodeMotionFrame = (frameData: string) => {
			lastEncodeTime = Date.now();
			// Send frame to encoder via direct CDP (bypasses Puppeteer's
			// ExecutionContext lookup, function serialization, Runtime.callFunctionOn
			// overhead, and result deserialization). Base64 charset [A-Za-z0-9+/=]
			// is safe to embed in a JS double-quoted string literal.
			cdp.send('Runtime.evaluate', {
				expression: `window.__webCodecsPeer?.encodeFrame("${frameData}")`,
				awaitPromise: false,
				returnByValue: false
			}).catch(() => {});
		};

		// Static top-off (Chrome-Remote-Desktop-style): screencastFrame only
		// fires on damage, so when no frame arrives for TOP_OFF_DELAY_MS the
		// page has gone still. Capture one lossless PNG screenshot and encode
		// it near-losslessly so the last (motion-degraded) frame doesn't stay
		// blurry on screen. One frame per still period — idle costs nothing.
		let topOffTimer: ReturnType<typeof setTimeout> | null = null;
		let capturingTopOff = false;

		const scheduleTopOff = () => {
			if (topOffTimer) clearTimeout(topOffTimer);
			topOffTimer = setTimeout(async () => {
				topOffTimer = null;
				const videoSession = this.sessions.get(sessionId);
				if (!videoSession?.isActive || session.isDestroyed || capturingTopOff) return;

				capturingTopOff = true;
				const frameCountAtCapture = cdpFrameCount;
				try {
					const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });

					// Discard if the page moved again while capturing —
					// new screencast frames already rescheduled the top-off
					if (cdpFrameCount !== frameCountAtCapture) return;

					cdp.send('Runtime.evaluate', {
						expression: `window.__webCodecsPeer?.encodeFrame("${screenshot.data}", true)`,
						awaitPromise: false,
						returnByValue: false
					}).catch(() => {});
				} catch {
					// Page may be navigating/closing — top-off is best-effort
				} finally {
					capturingTopOff = false;
				}
			}, BrowserVideoCapture.TOP_OFF_DELAY_MS);
		};

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

			const now = Date.now();
			const elapsed = now - lastEncodeTime;

			if (elapsed < minFrameIntervalMs) {
				// Too soon — hold the LATEST frame and encode it when the slot
				// opens (trailing edge). Newer frames overwrite the pending one.
				pendingFrameData = event.data;
				if (!pendingFrameTimer) {
					pendingFrameTimer = setTimeout(() => {
						pendingFrameTimer = null;
						if (!pendingFrameData) return;
						const frameData = pendingFrameData;
						pendingFrameData = null;

						const vs = this.sessions.get(sessionId);
						if (!vs?.isActive || session.isDestroyed) return;

						encodeMotionFrame(frameData);
						scheduleTopOff();
					}, minFrameIntervalMs - elapsed);
				}
				scheduleTopOff();
				return;
			}

			// This frame supersedes any pending trailing frame
			pendingFrameData = null;

			encodeMotionFrame(event.data);
			scheduleTopOff();
		});

		// Start screencast at native viewport resolution
		await cdp.send('Page.startScreencast', {
			format: 'jpeg',
			quality: config.video.screenshotQuality,
			maxWidth: viewport.width,
			maxHeight: viewport.height,
			everyNthFrame: 1
		});

		debug.log('webcodecs', `CDP screencast started at ${viewport.width}x${viewport.height}`);
		(session as any).__webCodecsCdp = cdp;
		(session as any).__webCodecsTopOffCancel = () => {
			if (topOffTimer) {
				clearTimeout(topOffTimer);
				topOffTimer = null;
			}
			if (pendingFrameTimer) {
				clearTimeout(pendingFrameTimer);
				pendingFrameTimer = null;
			}
			pendingFrameData = null;
		};
	}

	/**
	 * Create offer from headless browser
	 */
	async createOffer(sessionId: string, session: BrowserTab): Promise<RTCSessionDescriptionInit | null> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return null;
		}

		const maxRetries = 6;
		const retryDelay = 150;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				// Single evaluate: check peer + create offer in one IPC round-trip
				const offer = await session.page.evaluate(async () => {
					const peer = (window as any).__webCodecsPeer;
					if (typeof peer?.createOffer !== 'function') return null;
					return peer.createOffer();
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
	 * Update viewport without reconnection (hot-swap)
	 */
	async updateViewport(sessionId: string, session: BrowserTab, width: number, height: number): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot update viewport: session not active`);
			return false;
		}

		try {
			const page = session.page;
			const config = DEFAULT_STREAMING_CONFIG;

			debug.log('webcodecs', `🔄 Hot-swapping viewport to ${width}x${height}`);

			// Step 1: Update viewport via CDP (without page reload)
			await page.setViewport({ width, height });

			// Step 2: Reconfigure VideoEncoder with new dimensions and bitrate
			const bitrate = computeBitrate(width, height, config.video.framerate);
			const reconfigured = await page.evaluate((params) => {
				const peer = (window as any).__webCodecsPeer;
				if (!peer || !peer.reconfigureEncoder) return false;
				return peer.reconfigureEncoder(params.width, params.height, params.bitrate);
			}, { width, height, bitrate });

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
					maxWidth: width,
					maxHeight: height,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Viewport hot-swapped successfully to ${width}x${height}`);
			}

			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to update viewport:`, error);
			return false;
		}
	}

	/**
	 * Restart the CDP screencast at native viewport resolution.
	 * Used as a refresh/recovery path when the frontend detects a stuck stream
	 * (sent as a scale-update action). Display fit-scale no longer affects
	 * capture resolution, so no encoder reconfiguration is needed.
	 */
	async refreshScreencast(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot refresh screencast: session not active`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;
			const config = DEFAULT_STREAMING_CONFIG;

			const cdp = (session as any).__webCodecsCdp;
			if (cdp) {
				await cdp.send('Page.stopScreencast').catch(() => {});
				await cdp.send('Page.startScreencast', {
					format: 'jpeg',
					quality: config.video.screenshotQuality,
					maxWidth: viewport.width,
					maxHeight: viewport.height,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Screencast refreshed at ${viewport.width}x${viewport.height}`);
			}

			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to refresh screencast:`, error);
			return false;
		}
	}

	/**
	 * Client-driven keyframe request (PLI equivalent).
	 * Forces the next encoded frame to be a keyframe AND immediately pushes a
	 * high-quality screenshot through the encoder — so it works even on still
	 * pages where no screencast frames are flowing. Called when the frontend
	 * decoder errors or joins mid-stream and needs a sync point.
	 */
	async requestKeyframe(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			return false;
		}

		try {
			await session.page.evaluate(() => {
				(window as any).__webCodecsPeer?.forceKeyframe();
			});

			const cdp = (session as any).__webCodecsCdp;
			if (cdp) {
				const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png' });
				cdp.send('Runtime.evaluate', {
					expression: `window.__webCodecsPeer?.encodeFrame("${screenshot.data}", true)`,
					awaitPromise: false,
					returnByValue: false
				}).catch(() => {});
			}

			debug.log('webcodecs', `Keyframe requested for ${sessionId}`);
			return true;
		} catch (error) {
			debug.warn('webcodecs', `Failed to request keyframe:`, error);
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

			debug.log('webcodecs', `🔄 Handling navigation for ${sessionId} - re-injecting peer script and restarting screencast`);

			// Capture at native viewport resolution (see doPreInject)
			const videoConfig: StreamingConfig['video'] = {
				...config.video,
				width: viewport.width,
				height: viewport.height,
				bitrate: computeBitrate(viewport.width, viewport.height, config.video.framerate)
			};

			// Re-inject video encoder and audio capture scripts to new page context
			await page.evaluate(videoEncoderScript, videoConfig);
			await page.evaluate(audioCaptureScript, config.audio);

			// Single batched call: verify peer + start streaming + init audio
			const initResult = await page.evaluate(async (clientAllowsVp9) => {
				const peer = (window as any).__webCodecsPeer;
				if (typeof peer?.startStreaming !== 'function') {
					return { peerExists: false, started: false, audioInitialized: false };
				}

				const started = await peer.startStreaming(clientAllowsVp9);
				if (!started) {
					return { peerExists: true, started: false, audioInitialized: false };
				}

				let audioInitialized = false;
				const encoder = (window as any).__audioEncoder;
				if (typeof encoder?.init === 'function') {
					try {
						const initiated = await encoder.init();
						if (initiated) {
							audioInitialized = !!encoder.start();
						}
					} catch {}
				}

				return { peerExists: true, started: true, audioInitialized };
			}, videoSession.allowVp9);

			if (!initResult.peerExists) {
				debug.error('webcodecs', `Peer script re-injection failed - peer not available`);
				return false;
			}

			if (!initResult.started) {
				debug.error('webcodecs', `Failed to start streaming on new page`);
				return false;
			}

			if (initResult.audioInitialized) {
				debug.log('webcodecs', 'Audio re-initialized after navigation');
			} else {
				debug.warn('webcodecs', 'Audio not available after navigation, continuing with video only');
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
					maxWidth: viewport.width,
					maxHeight: viewport.height,
					everyNthFrame: 1
				});

				debug.log('webcodecs', `✅ Navigation handled - screencast restarted at ${viewport.width}x${viewport.height}`);
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
				// Cancel any pending top-off capture
				(session as any).__webCodecsTopOffCancel?.();
				(session as any).__webCodecsTopOffCancel = null;

				// Stop audio + peer in one IPC round-trip
				await session.page.evaluate(() => {
					(window as any).__audioEncoder?.stop();
					(window as any).__webCodecsPeer?.stopStreaming();
				}).catch(() => {});

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
