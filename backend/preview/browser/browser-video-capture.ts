/**
 * Browser Video Capture Handler
 *
 * Handles WebCodecs-based video streaming with WebRTC DataChannel transport.
 *
 * Video Architecture (Chrome-Remote-Desktop-style adaptive quality):
 * 1. Frames are captured at the resolution the viewer can actually display
 *    (fit-scale × devicePixelRatio, capped by the host's pixel budget)
 * 2. Capture runs either in-page (getDisplayMedia → VideoFrame, no round-trip)
 *    or via CDP screencast, which is ack-gated so Chrome never rasters a frame
 *    we would discard
 * 3. The page encodes with VideoEncoder — VP9 quantizer mode, H.264 when the
 *    viewer has hardware for it, VP8 as the universal floor
 * 4. When the page goes still, one near-lossless refresh frame is sent so text
 *    sharpens after motion stops
 * 5. Encoded chunks travel over a reliable ordered RTCDataChannel; latency is
 *    bounded by source-side frame dropping, driven by three independent
 *    signals: network buffer, encoder queue, and the viewer's decode queue
 *
 * Audio Architecture:
 * 1. AudioContext interception (handled by BrowserAudioCapture)
 * 2. Audio encoded with AudioEncoder (Opus) in headless browser
 * 3. Encoded chunks sent via sendAudioChunk() to same DataChannel
 *
 * Client:
 * - Receives video + audio chunks via DataChannel
 * - Decodes with VideoDecoder (off the main thread when the browser allows it)
 * - Renders video to canvas, plays audio with proper scheduling
 */

import { EventEmitter } from 'events';
import type { CDPSession, Page } from 'puppeteer';
import type {
	BrowserTab,
	ClientCodecSupport,
	ClientDisplayMetrics,
	ClientStreamFeedback,
	StreamingConfig
} from './types';
import { DEFAULT_STREAMING_CONFIG, resolveCodecCandidates } from './types';
import { videoEncoderScript } from './scripts/video-stream';
import { audioCaptureScript } from './scripts/audio-stream';

/**
 * Install the audio tap in every frame.
 *
 * `page.evaluate` only reaches the main frame, so a `<video>` or AudioContext
 * inside an iframe — an embedded player, anything served from a CDN origin —
 * was never tapped and the preview played silently. The script's own
 * idempotency guard makes the repeat injections harmless, and it relays its
 * encoded chunks up to the top frame's DataChannel.
 */
async function injectAudioCaptureIntoAllFrames(
	page: Page,
	audioConfig: StreamingConfig['audio']
): Promise<void> {
	await Promise.all(
		page.frames().map(async (frame) => {
			try {
				await frame.evaluate(audioCaptureScript, audioConfig);
			} catch {
				// Detached or navigating; the on-new-document copy covers it.
			}
		})
	);
}
import {
	computeBitrate,
	computeCaptureSize,
	getHostCaptureProfile,
	type CaptureProfile,
	type CaptureSize
} from './capture-profile';
import { debug } from '$shared/utils/logger';

/**
 * Encoder health reported back from the page every couple of seconds.
 * This is the CPU half of the backpressure story — `bufferedAmount` only ever
 * described the network.
 */
interface EncoderStats {
	captureMode: 'push' | 'native';
	codec: string;
	/** Mean main-thread cost per frame in the page: image decode + encode. */
	avgFrameCostMs: number;
	/** Peak encoder queue depth over the window, not an instantaneous sample. */
	encodeQueueMax: number;
	bufferedAmount: number;
	framesAttempted: number;
	framesSkippedEncoder: number;
	framesSkippedNetwork: number;
	/** Frames per second actually delivered to the viewer over the window. */
	measuredFps: number;
	width: number;
	height: number;
}

/**
 * One connected viewer of a tab.
 *
 * A tab is not watched by "the client" — it can be watched from a laptop and a
 * phone at once through Remote Access, or from two split panels in the same
 * window. Everything that used to live directly on the session and describe a
 * single viewer (its codecs, its screen, its ICE state) belongs here; what the
 * session keeps is the reduction across all of them.
 */
interface StreamViewer {
	id: string;
	/** Which codecs this viewer can decode. */
	codecSupport: ClientCodecSupport;
	/** Its fit-scale and screen density. */
	display: ClientDisplayMetrics;
	/** Answer received — ICE can be forwarded instead of queued. */
	connected: boolean;
	pendingCandidates: RTCIceCandidateInit[];
	/** Whether this viewer currently has the preview on screen. */
	visible: boolean;
	/** Latest decoder verdict — the ladder follows the worst viewer. */
	decoderSaturated: boolean;
}

interface VideoStreamSession {
	sessionId: string;
	isActive: boolean;
	paused: boolean;
	headlessReady: boolean;
	viewers: Map<string, StreamViewer>;
	scriptInjected: boolean; // Track if persistent script was injected
	scriptsPreInjected: boolean; // Track if scripts were pre-injected during tab creation
	audioOnNewDocumentInjected: boolean; // Track if evaluateOnNewDocument was registered for audio
	/** Codecs every viewer can decode — one encoder serves them all. */
	codecSupport: ClientCodecSupport;
	/** Display metrics of the most demanding viewer. */
	display: ClientDisplayMetrics;
	profile: CaptureProfile;
	capture: CaptureSize;
	/** Extra resolution derate applied when the fps floor isn't enough. */
	pixelDerate: number;
	targetFramerate: number;
	captureMode: 'push' | 'native';
	/** Consecutive healthy adaptation windows — gates recovery upward. */
	healthyWindows: number;
	/**
	 * Consecutive saturated windows. Degrading on a single report made the
	 * ladder a one-way ratchet: any momentary spike stepped the framerate down,
	 * and because a degrade resets the recovery counter, one spike every few
	 * seconds was enough to walk the stream to its floor and pin it there.
	 */
	saturatedWindows: number;
	/** When client feedback last moved the ladder — see applyClientFeedback. */
	lastClientAdaptAt: number;
	/**
	 * The tab this session streams. Kept here so adaptation triggered from the
	 * page (encoder stats arrive through an exposed binding, with no tab in
	 * hand) can still reach the page to change capture geometry.
	 */
	tab?: BrowserTab;
	stats: {
		videoBytesSent: number;
		audioBytesSent: number;
		videoFramesEncoded: number;
		audioFramesEncoded: number;
		connectionState: string;
	};
}

/**
 * Framerate ladder. Discrete so the stream settles instead of oscillating;
 * clamped per session to the host profile's [minFramerate, maxFramerate].
 */
const FRAMERATE_LADDER = [6, 8, 10, 12, 15, 18, 20, 24, 30];

/**
 * Resolution derates applied only after the framerate floor is reached. Going
 * coarser beats going slower — a sharp slideshow reads worse than a soft but
 * fluid stream — so this is the last resort, not the first.
 */
const PIXEL_DERATE_LADDER = [1, 0.85, 0.7, 0.55];

const DEFAULT_CODEC_SUPPORT: ClientCodecSupport = {
	vp8: true,
	vp9: true,
	avc: false,
	hardware: []
};

/**
 * CDP screencast feeder with ack-gated flow control.
 *
 * `Page.screencastFrame` fires at the compositor rate (up to 60fps) and Chrome
 * withholds the next frame until the current one is acked. Acking immediately
 * and discarding surplus frames downstream — the previous design — meant the
 * renderer still rastered, JPEG-encoded and base64'd every one of them, and
 * the process still parsed them, before we threw half away. Holding the ack
 * for one frame interval moves that throttle to the only place it actually
 * saves work: before the frame is produced.
 */
class ScreencastFeeder {
	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private topOffTimer: ReturnType<typeof setTimeout> | null = null;
	private peerObjectId: string | null = null;
	private acquiringPeer = false;
	private capturingTopOff = false;
	private frameSeq = 0;
	private destroyed = false;
	private running = false;
	private lastDispatchAt = 0;
	private lastAckAt = 0;
	private pendingAckId: number | null = null;

	constructor(
		private readonly cdp: CDPSession,
		private readonly label: string,
		private readonly getSession: () => VideoStreamSession | undefined,
		private readonly getTab: () => BrowserTab | undefined,
		private readonly onInvalidSession: () => void,
		private readonly isValidSession: () => boolean
	) {
		this.cdp.on('Page.screencastFrame', (event: any) => this.handleFrame(event));
	}

	/** Milliseconds a frame is held before acking — i.e. the source frame budget. */
	private get frameIntervalMs(): number {
		const fps = this.getSession()?.targetFramerate || DEFAULT_STREAMING_CONFIG.video.framerate;
		return Math.max(16, Math.round(1000 / fps));
	}

	async start(width: number, height: number, quality: number): Promise<void> {
		if (this.destroyed) return;

		// Acquire the encoder handle before the first frame so no frame is
		// wasted waiting for it.
		await this.acquirePeerHandle();

		await this.cdp.send('Page.startScreencast', {
			format: 'jpeg',
			quality,
			maxWidth: width,
			maxHeight: height,
			everyNthFrame: 1
		});

		this.running = true;
		debug.log('webcodecs', `CDP screencast started for ${this.label} at ${width}x${height} (q${quality})`);
	}

	async restart(width: number, height: number, quality: number): Promise<void> {
		if (this.destroyed) return;
		this.clearTimers();
		await this.cdp.send('Page.stopScreencast').catch(() => {});
		this.running = false;
		await this.start(width, height, quality);
	}

	async pause(): Promise<void> {
		if (!this.running) return;
		this.clearTimers();
		this.running = false;
		await this.cdp.send('Page.stopScreencast').catch(() => {});
	}

	/** Invalidate the cached page handle — the execution context is gone. */
	invalidatePeerHandle(): void {
		this.peerObjectId = null;
	}

	private async acquirePeerHandle(): Promise<void> {
		if (this.destroyed || this.acquiringPeer || this.peerObjectId) return;
		this.acquiringPeer = true;
		try {
			const result: any = await this.cdp.send('Runtime.evaluate', {
				expression: 'window.__webCodecsPeer',
				returnByValue: false,
				silent: true
			});
			this.peerObjectId = result?.result?.objectId ?? null;
		} catch {
			this.peerObjectId = null;
		} finally {
			this.acquiringPeer = false;
		}
	}

	/**
	 * Hand a frame to the page encoder.
	 *
	 * The payload travels as a `callFunctionOn` **argument**, not interpolated
	 * into a `Runtime.evaluate` expression. Interpolation made V8 parse and
	 * compile a fresh source string containing the whole base64 frame on every
	 * single frame — hundreds of kilobytes of compilation per frame, for a
	 * call that never changes.
	 */
	private dispatch(data: string, isTopOff: boolean, mimeType: string): void {
		if (this.destroyed) return;

		if (!this.peerObjectId) {
			void this.acquirePeerHandle();
			return;
		}

		this.cdp
			.send('Runtime.callFunctionOn', {
				objectId: this.peerObjectId,
				functionDeclaration: 'function(d,t,m){this.encodeFrame(d,t,m)}',
				arguments: [{ value: data }, { value: isTopOff }, { value: mimeType }],
				returnByValue: false,
				awaitPromise: false,
				silent: true
			} as any)
			.catch(() => {
				// Stale handle (navigation) — the next frame re-acquires it.
				this.peerObjectId = null;
			});
	}

	private ack(cdpSessionId: number): void {
		this.cdp.send('Page.screencastFrameAck', { sessionId: cdpSessionId }).catch(() => {});
	}

	private handleFrame(event: any): void {
		this.frameSeq++;

		// Every frame must be acknowledged exactly once — Chrome counts frames
		// in flight and stops producing once that count sticks. If a previous
		// ack is still held, release it now rather than replacing it.
		this.flushPendingAck();

		const session = this.getSession();
		const tab = this.getTab();

		// Ack immediately when we're not consuming — never leave the screencast
		// waiting on an ack that will not come, or it stalls permanently.
		if (this.destroyed || !session?.isActive || session.paused || tab?.isDestroyed) {
			this.ack(event.sessionId);
			return;
		}

		if (!this.isValidSession()) {
			this.ack(event.sessionId);
			this.onInvalidSession();
			return;
		}

		// Native capture drives the encoder itself; the screencast should
		// already be stopped, but ack defensively so nothing wedges.
		if (session.captureMode === 'native') {
			this.ack(event.sessionId);
			return;
		}

		const now = Date.now();
		const interval = this.frameIntervalMs;

		try {
			// Belt-and-braces rate limit against a source that isn't honouring
			// ack flow control. The margin is loose on purpose: under working
			// flow control frames already arrive one interval apart, and
			// dropping one costs a *whole* extra interval (the next frame is
			// only produced after our ack), which reads as judder.
			if (this.lastDispatchAt > 0 && now - this.lastDispatchAt < interval * 0.6) {
				return;
			}

			this.lastDispatchAt = now;
			this.dispatch(event.data, false, 'image/jpeg');
			this.scheduleTopOff();
		} finally {
			// Self-calibrating hold. The period the viewer actually sees is
			// `hold + however long the source takes to produce and deliver the
			// next frame`, so holding a full interval on top of that undershoots
			// the target framerate — measurably, and visibly as stutter. Measure
			// the pipeline (last ack → this frame) and hold only the remainder.
			const pipelineMs = this.lastAckAt > 0 ? Math.max(0, now - this.lastAckAt) : 0;
			const hold = Math.max(0, interval - pipelineMs);

			this.pendingAckId = event.sessionId;
			this.ackTimer = setTimeout(() => {
				this.ackTimer = null;
				this.sendPendingAck();
			}, hold);
		}
	}

	private flushPendingAck(): void {
		if (!this.ackTimer) return;
		clearTimeout(this.ackTimer);
		this.ackTimer = null;
		this.sendPendingAck();
	}

	private sendPendingAck(): void {
		if (this.pendingAckId === null) return;
		const id = this.pendingAckId;
		this.pendingAckId = null;
		this.lastAckAt = Date.now();
		this.ack(id);
	}

	/**
	 * Static top-off: screencastFrame only fires on damage, so when no frame
	 * arrives for TOP_OFF_DELAY_MS the page has gone still. Capture one
	 * high-quality screenshot and encode it near-losslessly so the last
	 * (motion-degraded) frame doesn't stay soft on screen. One frame per still
	 * period — idle costs nothing.
	 */
	scheduleTopOff(): void {
		if (this.destroyed) return;
		if (this.topOffTimer) clearTimeout(this.topOffTimer);

		// The delay has to clear the gap between two motion frames, or a slow
		// stream looks "still" between every frame and pays for a screenshot
		// plus a near-lossless keyframe in the middle of actual motion.
		const delay = Math.max(BrowserVideoCapture.TOP_OFF_DELAY_MS, this.frameIntervalMs * 2);

		this.topOffTimer = setTimeout(async () => {
			this.topOffTimer = null;

			const session = this.getSession();
			const tab = this.getTab();
			if (!session?.isActive || session.paused || tab?.isDestroyed || this.capturingTopOff) return;
			if (session.captureMode === 'native') return; // handled in-page from the retained frame

			this.capturingTopOff = true;
			const seqAtCapture = this.frameSeq;

			try {
				const profile = session.profile;
				const viewport = tab?.page?.viewport();
				const params: Record<string, unknown> = {
					format: profile.topOffFormat,
					captureBeyondViewport: false,
					optimizeForSpeed: true
				};

				if (profile.topOffFormat === 'jpeg') {
					params.quality = profile.topOffQuality;
				}

				// The refresh frame must arrive at the encoder's geometry, so
				// it is captured through the same scale as the screencast.
				if (viewport && session.capture.scale < 0.999) {
					params.clip = {
						x: 0,
						y: 0,
						width: viewport.width,
						height: viewport.height,
						scale: session.capture.scale
					};
				}

				const screenshot: any = await this.cdp.send('Page.captureScreenshot', params as any);

				// Discard if the page moved again while capturing — new
				// screencast frames already rescheduled the top-off.
				if (this.frameSeq !== seqAtCapture || this.destroyed) return;

				this.dispatch(
					screenshot.data,
					true,
					profile.topOffFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
				);
			} catch {
				// Page may be navigating/closing — top-off is best-effort
			} finally {
				this.capturingTopOff = false;
			}
		}, delay);
	}

	private clearTimers(): void {
		// Release the held frame before dropping the timer. The screencast is
		// about to be stopped either way, but leaving Chrome's in-flight count
		// non-zero would wedge the next start.
		this.flushPendingAck();
		this.lastDispatchAt = 0;
		this.lastAckAt = 0;

		if (this.topOffTimer) {
			clearTimeout(this.topOffTimer);
			this.topOffTimer = null;
		}
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		this.running = false;
		this.clearTimers();
		await this.cdp.send('Page.stopScreencast').catch(() => {});
		await this.cdp.detach().catch(() => {});
	}
}

export class BrowserVideoCapture extends EventEmitter {
	/**
	 * How long the screencast must be silent (no damage → no frames) before
	 * the page is considered still and a near-lossless top-off frame is sent.
	 * Long enough to skip inter-frame gaps of animations, short enough that
	 * text sharpens almost immediately after scrolling stops.
	 */
	static readonly TOP_OFF_DELAY_MS = 300;

	/** Debounce for viewer resize storms before touching the encoder. */
	private static readonly DISPLAY_METRICS_DEBOUNCE_MS = 250;

	/**
	 * Minimum gap between ladder moves driven by viewer feedback. Matches the
	 * viewers' own reporting interval, so N viewers still produce one verdict
	 * per window rather than N.
	 */
	private static readonly CLIENT_ADAPT_INTERVAL_MS = 1500;

	private sessions = new Map<string, VideoStreamSession>();
	private feeders = new Map<string, ScreencastFeeder>();
	private preInjectPromises = new Map<string, Promise<boolean>>();
	private displayMetricsTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor() {
		super();
	}

	// ------------------------------------------------------------------
	// Session configuration
	// ------------------------------------------------------------------

	/**
	 * Build the per-session video config: capture geometry from the viewer's
	 * display metrics, quality ceilings from the host profile, and the codec
	 * order from the viewer's decode capabilities.
	 */
	private buildVideoConfig(
		videoSession: VideoStreamSession,
		viewport: { width: number; height: number }
	): StreamingConfig['video'] {
		const profile = videoSession.profile;

		const derated = {
			...profile,
			maxPixels: Math.round(profile.maxPixels * videoSession.pixelDerate)
		};

		videoSession.capture = computeCaptureSize(
			viewport.width,
			viewport.height,
			videoSession.display.scale,
			videoSession.display.dpr,
			derated
		);

		const { width, height } = videoSession.capture;

		return {
			...DEFAULT_STREAMING_CONFIG.video,
			width,
			height,
			framerate: videoSession.targetFramerate,
			minFramerate: profile.minFramerate,
			bitrate: computeBitrate(width, height, videoSession.targetFramerate),
			screenshotQuality: profile.screenshotQuality,
			motionQuantizer: profile.motionQuantizer,
			topOffQuantizer: profile.topOffQuantizer,
			codecCandidates: resolveCodecCandidates(videoSession.codecSupport),
			nativeCapture: isNativeCaptureEnabled()
		};
	}

	private buildAudioConfig(videoSession: VideoStreamSession): StreamingConfig['audio'] {
		return {
			...DEFAULT_STREAMING_CONFIG.audio,
			bitrate: videoSession.profile.audioBitrate
		};
	}

	/**
	 * Fold every viewer's capabilities into the one configuration the shared
	 * encoder can have.
	 *
	 * Codecs intersect: a codec only one viewer can decode is useless, because
	 * the same encoded chunks go to all of them. Resolution takes the maximum:
	 * capturing for the sharpest screen costs the others nothing but a downscale
	 * at paint time, whereas capturing for the smallest would leave the sharpest
	 * viewer permanently blurry. The host's pixel budget still caps the result.
	 */
	private refreshViewerConfig(videoSession: VideoStreamSession): void {
		const viewers = Array.from(videoSession.viewers.values());
		if (viewers.length === 0) return;

		videoSession.codecSupport = {
			vp8: viewers.every((viewer) => viewer.codecSupport.vp8),
			vp9: viewers.every((viewer) => viewer.codecSupport.vp9),
			avc: viewers.every((viewer) => viewer.codecSupport.avc),
			hardware: (['vp8', 'vp9', 'avc'] as const).filter((codec) =>
				viewers.every((viewer) => viewer.codecSupport.hardware.includes(codec))
			)
		};

		// Collapsed to a single factor rather than max(scale) × max(dpr): those
		// maxima can come from different viewers, and their product would be a
		// resolution nobody asked for.
		let demand = 0;
		for (const viewer of viewers) {
			const scale = viewer.display.scale && viewer.display.scale > 0 ? viewer.display.scale : 1;
			const dpr = viewer.display.dpr && viewer.display.dpr > 0 ? viewer.display.dpr : 1;
			demand = Math.max(demand, scale * dpr);
		}

		videoSession.display = demand > 0 ? { scale: Math.min(1, demand), dpr: 1 } : {};
	}

	/** A stream is only worth pausing once nobody is looking at it. */
	private allViewersHidden(videoSession: VideoStreamSession): boolean {
		if (videoSession.viewers.size === 0) return true;
		return Array.from(videoSession.viewers.values()).every((viewer) => !viewer.visible);
	}

	private createSessionState(sessionId: string): VideoStreamSession {
		const profile = getHostCaptureProfile();
		return {
			sessionId,
			isActive: false,
			paused: false,
			headlessReady: false,
			viewers: new Map(),
			scriptInjected: false,
			scriptsPreInjected: false,
			audioOnNewDocumentInjected: false,
			codecSupport: { ...DEFAULT_CODEC_SUPPORT },
			display: {},
			profile,
			capture: { width: 0, height: 0, scale: 1 },
			pixelDerate: 1,
			targetFramerate: profile.maxFramerate,
			captureMode: 'push',
			healthyWindows: 0,
			saturatedWindows: 0,
			lastClientAdaptAt: 0,
			stats: {
				videoBytesSent: 0,
				audioBytesSent: 0,
				videoFramesEncoded: 0,
				audioFramesEncoded: 0,
				connectionState: 'new'
			}
		};
	}

	// ------------------------------------------------------------------
	// Script injection
	// ------------------------------------------------------------------

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

			const videoSession = this.createSessionState(sessionId);
			videoSession.scriptInjected = true;
			this.sessions.set(sessionId, videoSession);

			await this.injectScripts(sessionId, page, this.buildVideoConfig(videoSession, viewport), this.buildAudioConfig(videoSession));

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
		audioConfig: StreamingConfig['audio']
	): Promise<void> {
		// Check if bindings exist
		const bindingsExist = await page.evaluate(() => {
			return typeof (window as any).__sendIceCandidate === 'function';
		});

		// Expose signaling functions (persists across navigations).
		//
		// Every one of these is bound to the tab whose page it was injected into.
		// They used to resolve their session by picking the first active one in
		// the whole project, which is correct only while exactly one tab streams:
		// with several open, one page's ICE candidates, connection states, cursor
		// and encoder stats were all attributed to a different tab. The viewer
		// filters those by tab, so its candidates were silently discarded and the
		// connection never completed — and because the first refresh frame is
		// pushed from the `connected` state, a still page also never produced a
		// first frame. That is the "Loading preview…" that never resolves.
		if (!bindingsExist) {
			await page.exposeFunction('__sendIceCandidate', (viewerId: string, candidate: RTCIceCandidateInit) => {
				this.emit('ice-candidate', { sessionId, viewerId, candidate, from: 'headless' });
			});

			await page.exposeFunction('__sendConnectionState', (viewerId: string, state: string) => {
				const videoSession = this.sessions.get(sessionId);
				if (!videoSession) return;

				videoSession.stats.connectionState = state;
				this.emit('connection-state', { sessionId, viewerId, state });

				// Capture sources only produce frames on damage, so a viewer
				// that connects to an already-still page would otherwise wait
				// for the first mouse move to see anything. Push one refresh
				// frame as soon as the peer is up.
				if (state === 'connected' && videoSession.tab) {
					void this.requestKeyframe(sessionId, videoSession.tab);
				}

				if (state === 'closed' || state === 'failed') {
					videoSession.viewers.delete(viewerId);
				}
			});

			// A channel that has just opened has no frame to show yet on a still
			// page — see the matching comment in video-stream.ts.
			await page.exposeFunction('__requestRefreshFrame', (viewerId: string) => {
				const videoSession = this.sessions.get(sessionId);
				if (!videoSession?.tab) return;
				debug.log('webcodecs', `Refresh frame requested by viewer ${viewerId} on ${sessionId}`);
				void this.requestKeyframe(sessionId, videoSession.tab);
			});

			await page.exposeFunction('__sendCursorChange', (cursor: string) => {
				this.emit('cursor-change', { sessionId, cursor });
			});

			await page.exposeFunction('__sendEncoderStats', (stats: EncoderStats) => {
				this.applyEncoderStats(sessionId, stats);
			});
		}

		// Register audio capture as a startup script — runs before page scripts on every new document load.
		// Critical for SPAs that create AudioContext during initialization (before page.evaluate runs).
		// The idempotency guard in audioCaptureScript prevents double-injection.
		const session = this.sessions.get(sessionId);
		if (session && !session.audioOnNewDocumentInjected) {
			await page.evaluateOnNewDocument(audioCaptureScript, audioConfig);
			session.audioOnNewDocumentInjected = true;
		}

		// Inject video encoder + audio capture scripts into the current page context
		await page.evaluate(videoEncoderScript, videoConfig);
		await injectAudioCaptureIntoAllFrames(page, audioConfig);
	}

	// ------------------------------------------------------------------
	// Viewers
	// ------------------------------------------------------------------

	/**
	 * Record (or refresh) a viewer and re-derive the shared encoder config.
	 */
	private registerViewer(
		videoSession: VideoStreamSession,
		options: {
			viewerId: string;
			codecSupport?: ClientCodecSupport;
			display?: ClientDisplayMetrics;
		}
	): StreamViewer {
		const existing = videoSession.viewers.get(options.viewerId);

		const viewer: StreamViewer = existing ?? {
			id: options.viewerId,
			codecSupport: { ...DEFAULT_CODEC_SUPPORT },
			display: {},
			connected: false,
			pendingCandidates: [],
			visible: true,
			decoderSaturated: false
		};

		if (options.codecSupport) viewer.codecSupport = options.codecSupport;
		if (options.display) viewer.display = { ...viewer.display, ...options.display };
		// A fresh handshake means a fresh peer: whatever ICE was queued for the
		// previous one belongs to a connection that no longer exists.
		viewer.connected = false;
		viewer.pendingCandidates = [];
		viewer.visible = true;

		videoSession.viewers.set(viewer.id, viewer);
		this.refreshViewerConfig(videoSession);

		return viewer;
	}

	/**
	 * Add a viewer to a stream that is already running.
	 *
	 * Nothing about the capture is disturbed — the existing viewers keep their
	 * channels. Only the shared geometry is re-derived, in case the newcomer has
	 * a sharper screen than anyone already watching.
	 */
	private async attachViewer(
		sessionId: string,
		session: BrowserTab,
		options: {
			viewerId: string;
			codecSupport?: ClientCodecSupport;
			display?: ClientDisplayMetrics;
		}
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive) return false;

		this.registerViewer(videoSession, options);
		videoSession.tab = session;

		// The stream may have been paused because everyone watching had it off
		// screen; someone is watching again.
		await this.setPaused(sessionId, session, false);
		await this.applyCaptureGeometry(sessionId, session);
		return true;
	}

	/**
	 * Drop a viewer. The capture only stops once the last one is gone —
	 * otherwise closing one device's panel would blank every other device.
	 * Returns whether the whole stream was torn down.
	 */
	async detachViewer(sessionId: string, session: BrowserTab | undefined, viewerId: string): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession) return false;

		videoSession.viewers.delete(viewerId);

		if (session?.page && !session.page.isClosed()) {
			await session.page
				.evaluate((id: string) => {
					(window as any).__webCodecsPeer?.closePeer(id);
				}, viewerId)
				.catch(() => {});
		}

		if (videoSession.viewers.size > 0) {
			this.refreshViewerConfig(videoSession);
			debug.log(
				'webcodecs',
				`Viewer ${viewerId} left ${sessionId}, ${videoSession.viewers.size} still watching`
			);
			if (session && this.allViewersHidden(videoSession)) {
				await this.setPaused(sessionId, session, true);
			}
			return false;
		}

		await this.stopStreaming(sessionId, session);
		return true;
	}

	// ------------------------------------------------------------------
	// Stream lifecycle
	// ------------------------------------------------------------------

	/**
	 * Start video streaming for a session
	 */
	async startStreaming(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean,
		options: {
			viewerId: string;
			codecSupport?: ClientCodecSupport;
			display?: ClientDisplayMetrics;
		}
	): Promise<boolean> {
		const { viewerId } = options;
		debug.log('webcodecs', `Starting streaming for session ${sessionId} (viewer ${viewerId})`);

		// Wait for any pending pre-injection to complete
		const pendingPreInject = this.preInjectPromises.get(sessionId);
		if (pendingPreInject) {
			debug.log('webcodecs', `Waiting for pre-injection to complete for ${sessionId}`);
			await pendingPreInject.catch(() => {});
		}

		// A viewer re-handshaking (its own recovery path) gets a clean restart
		// only when it is the sole viewer — that is the case the recovery logic
		// was written for. Tearing the capture down because a *second* viewer
		// arrived is what made two devices fight over one tab: each new
		// handshake killed the other side's channel, whose health check
		// reconnected and killed this one straight back.
		const existingSession = this.sessions.get(sessionId);
		if (existingSession?.isActive) {
			const others = Array.from(existingSession.viewers.keys()).filter((id) => id !== viewerId);
			if (others.length === 0) {
				debug.log('webcodecs', `Session ${sessionId} already active for its only viewer, restarting clean`);
				await this.stopStreaming(sessionId, session);
			} else {
				debug.log(
					'webcodecs',
					`Session ${sessionId} already streaming to ${others.length} other viewer(s), attaching ${viewerId}`
				);
				return this.attachViewer(sessionId, session, options);
			}
		}

		if (!session.page || session.page.isClosed()) {
			debug.error('webcodecs', `Cannot start: page is closed`);
			return false;
		}

		try {
			const page = session.page;
			const viewport = page.viewport()!;

			// Get or create session tracking
			let videoSession = this.sessions.get(sessionId);
			if (!videoSession) {
				videoSession = this.createSessionState(sessionId);
				this.sessions.set(sessionId, videoSession);
			}

			videoSession.tab = session;
			this.registerViewer(videoSession, options);
			videoSession.paused = false;
			videoSession.captureMode = 'push';
			videoSession.healthyWindows = 0;

			const videoConfig = this.buildVideoConfig(videoSession, viewport);
			const audioConfig = this.buildAudioConfig(videoSession);

			// The pre-injected script was configured before the viewer's codec
			// support and display metrics were known, so re-inject whenever the
			// handshake carried either.
			const mustReinject = !videoSession.scriptsPreInjected || !!options?.codecSupport || !!options?.display;
			if (mustReinject) {
				await this.injectScripts(sessionId, page, videoConfig, audioConfig);
				videoSession.scriptInjected = true;
			} else {
				debug.log('webcodecs', `Scripts already pre-injected for ${sessionId}, skipping injection`);
			}

			// Single batched call: verify peer + start streaming + init audio
			// (saves ~60ms of IPC overhead vs 4 separate page.evaluate calls)
			const initResult = await page.evaluate(async () => {
				const peer = (window as any).__webCodecsPeer;
				if (typeof peer?.startStreaming !== 'function') {
					return { peerExists: false, started: false, audioInitialized: false };
				}

				const started = await peer.startStreaming();
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
			});

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

			await this.setupCapture(sessionId, session, isValidSession);

			debug.log(
				'webcodecs',
				`Streaming started for ${sessionId} — ${videoSession.capture.width}x${videoSession.capture.height} ` +
					`@${videoSession.targetFramerate}fps (${videoSession.captureMode}, ${videoSession.profile.tier})`
			);
			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to start streaming:`, error);
			await this.destroyFeeder(sessionId);
			this.sessions.delete(sessionId);
			throw error;
		}
	}

	/**
	 * Bring up a capture source for the session.
	 *
	 * In-page capture is tried first: it hands compositor frames straight to
	 * the encoder, skipping a JPEG encode, a base64 hop through this process,
	 * and a JPEG decode. It needs a secure context, so any page served over
	 * plain http falls back to the CDP screencast — which is why the fallback
	 * is a first-class path and not an error case.
	 */
	private async setupCapture(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean
	): Promise<void> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession) return;

		if (await this.tryStartNativeCapture(sessionId, session)) {
			videoSession.captureMode = 'native';
			// Native capture drives the encoder itself — a leftover screencast
			// from a previous page would fight it for the same encoder.
			await this.destroyFeeder(sessionId);
			debug.log('webcodecs', `Native in-page capture active for ${sessionId}`);
			return;
		}

		videoSession.captureMode = 'push';
		await this.setupFrameFeeder(sessionId, session, isValidSession);
	}

	private async tryStartNativeCapture(sessionId: string, session: BrowserTab): Promise<boolean> {
		if (!isNativeCaptureEnabled()) return false;
		if (!session.page || session.page.isClosed()) return false;

		try {
			// getDisplayMedia requires transient user activation, which only
			// CDP's `userGesture` flag can grant to an automated page.
			const cdp = await session.page.createCDPSession();
			try {
				const result: any = await cdp.send('Runtime.evaluate', {
					expression: 'window.__webCodecsPeer && window.__webCodecsPeer.startNativeCapture()',
					awaitPromise: true,
					returnByValue: true,
					userGesture: true,
					silent: true,
					timeout: 4000
				} as any);

				return result?.result?.value === true;
			} finally {
				await cdp.detach().catch(() => {});
			}
		} catch (error) {
			debug.log('webcodecs', `Native capture unavailable for ${sessionId}, using screencast`);
			return false;
		}
	}

	/**
	 * Setup CDP screencast to feed frames to VideoEncoder
	 */
	private async setupFrameFeeder(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean
	): Promise<void> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession) return;

		await this.destroyFeeder(sessionId);

		const cdp = await session.page.createCDPSession();
		const feeder = new ScreencastFeeder(
			cdp,
			sessionId,
			() => this.sessions.get(sessionId),
			() => session,
			() => {
				void this.stopStreaming(sessionId);
			},
			isValidSession
		);

		this.feeders.set(sessionId, feeder);

		await feeder.start(
			videoSession.capture.width,
			videoSession.capture.height,
			videoSession.profile.screenshotQuality
		);
	}

	private async destroyFeeder(sessionId: string): Promise<void> {
		const feeder = this.feeders.get(sessionId);
		if (!feeder) return;
		this.feeders.delete(sessionId);
		await feeder.destroy();
	}

	// ------------------------------------------------------------------
	// Adaptive quality
	// ------------------------------------------------------------------

	private framerateLadder(profile: CaptureProfile): number[] {
		const ladder = FRAMERATE_LADDER.filter(
			(fps) => fps >= profile.minFramerate && fps <= profile.maxFramerate
		);
		return ladder.length > 0 ? ladder : [profile.maxFramerate];
	}

	/**
	 * Fold one health report into the quality ladder.
	 *
	 * Framerate moves first and resolution only after the fps floor is reached,
	 * because a soft-but-fluid stream reads far better than a sharp slideshow.
	 * Recovery requires several consecutive healthy windows so a single quiet
	 * moment doesn't push the stream straight back into saturation.
	 */
	private adaptQuality(sessionId: string, degrade: boolean): void {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive) return;

		const session = videoSession.tab;

		const ladder = this.framerateLadder(videoSession.profile);
		const fpsIndex = Math.max(0, ladder.indexOf(videoSession.targetFramerate));
		const derateIndex = Math.max(0, PIXEL_DERATE_LADDER.indexOf(videoSession.pixelDerate));

		let nextFps = videoSession.targetFramerate;
		let nextDerate = videoSession.pixelDerate;

		if (degrade) {
			videoSession.healthyWindows = 0;
			videoSession.saturatedWindows++;
			// Only act on sustained pressure. A single window can be saturated
			// by one heavy repaint, and reacting to that is what turned the
			// ladder into a one-way ratchet.
			if (videoSession.saturatedWindows < 2) return;
			videoSession.saturatedWindows = 0;

			if (fpsIndex > 0) {
				nextFps = ladder[fpsIndex - 1];
			} else if (derateIndex < PIXEL_DERATE_LADDER.length - 1) {
				nextDerate = PIXEL_DERATE_LADDER[derateIndex + 1];
			} else {
				return; // already at the floor
			}
		} else {
			videoSession.saturatedWindows = 0;
			videoSession.healthyWindows++;
			if (videoSession.healthyWindows < 2) return;
			videoSession.healthyWindows = 0;

			// Recover framerate before resolution. Stutter is what the eye
			// objects to first, so smoothness is bought back before sharpness.
			if (fpsIndex < ladder.length - 1) {
				nextFps = ladder[fpsIndex + 1];
			} else if (derateIndex > 0) {
				nextDerate = PIXEL_DERATE_LADDER[derateIndex - 1];
			} else {
				return; // already at the ceiling
			}
		}

		if (nextFps === videoSession.targetFramerate && nextDerate === videoSession.pixelDerate) return;

		const fpsChanged = nextFps !== videoSession.targetFramerate;
		const derateChanged = nextDerate !== videoSession.pixelDerate;

		videoSession.targetFramerate = nextFps;
		videoSession.pixelDerate = nextDerate;

		debug.log(
			'webcodecs',
			`Quality ${degrade ? '↓' : '↑'} for ${sessionId}: ${nextFps}fps, derate ${nextDerate}`
		);

		if (fpsChanged) {
			void this.pushTargetFramerate(sessionId, session, nextFps);
		}
		if (derateChanged && session) {
			void this.applyCaptureGeometry(sessionId, session);
		}
	}

	private async pushTargetFramerate(
		sessionId: string,
		session: BrowserTab | undefined,
		fps: number
	): Promise<void> {
		if (!session?.page || session.page.isClosed()) return;
		try {
			await session.page.evaluate((value: number) => {
				(window as any).__webCodecsPeer?.setTargetFramerate(value);
			}, fps);
		} catch {
			// Page may be navigating — the next start/navigation re-applies it
		}
	}

	/**
	 * Recompute the capture geometry and push it through the whole chain:
	 * the page encoder, and the screencast (or the capture track in native
	 * mode, which `reconfigureEncoder` handles in-page).
	 */
	private async applyCaptureGeometry(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) return false;

		const viewport = session.page.viewport();
		if (!viewport) return false;

		const previous = videoSession.capture;
		const videoConfig = this.buildVideoConfig(videoSession, viewport);
		const next = videoSession.capture;

		// Ignore sub-3% changes — reconfiguring costs a keyframe, and a resize
		// drag would otherwise fire dozens of them. Roll the recomputed value
		// back so the recorded geometry keeps matching the live encoder (the
		// top-off clip scale is read from it).
		if (
			previous.width > 0 &&
			Math.abs(next.width - previous.width) / previous.width < 0.03 &&
			Math.abs(next.height - previous.height) / previous.height < 0.03
		) {
			videoSession.capture = previous;
			return true;
		}

		try {
			const reconfigured = await session.page.evaluate(
				(params: { width: number; height: number; bitrate: number }) => {
					const peer = (window as any).__webCodecsPeer;
					if (!peer?.reconfigureEncoder) return false;
					return peer.reconfigureEncoder(params.width, params.height, params.bitrate);
				},
				{ width: next.width, height: next.height, bitrate: videoConfig.bitrate }
			);

			if (!reconfigured) {
				debug.warn('webcodecs', `Encoder reconfigure rejected for ${sessionId}`);
			}

			const feeder = this.feeders.get(sessionId);
			if (feeder && videoSession.captureMode === 'push') {
				await feeder.restart(next.width, next.height, videoSession.profile.screenshotQuality);
			}

			debug.log(
				'webcodecs',
				`Capture geometry for ${sessionId}: ${next.width}x${next.height} ` +
					`(viewport ${viewport.width}x${viewport.height}, scale ${next.scale.toFixed(2)})`
			);
			return true;
		} catch (error) {
			debug.warn('webcodecs', `Failed to apply capture geometry:`, error);
			return false;
		}
	}

	/**
	 * Encoder health from the page. Saturation here means this host cannot
	 * produce frames fast enough, which no amount of network headroom fixes.
	 */
	private applyEncoderStats(sessionId: string, stats: EncoderStats): void {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive) return;

		videoSession.captureMode = stats.captureMode || videoSession.captureMode;

		// In-page capture can end on its own — the captured surface goes away
		// on some navigations — and the page has no way to start a screencast.
		// Detecting the drop here is what keeps the preview from freezing on
		// its last frame.
		if (
			videoSession.captureMode === 'push' &&
			!videoSession.paused &&
			!this.feeders.has(sessionId) &&
			videoSession.tab
		) {
			debug.warn('webcodecs', `Native capture ended for ${sessionId}, falling back to screencast`);
			const tab = videoSession.tab;
			void this.setupFrameFeeder(sessionId, tab, () => !tab.isDestroyed);
		}

		const frameBudgetMs = 1000 / Math.max(1, videoSession.targetFramerate);
		const skipRatio =
			stats.framesAttempted > 0 ? stats.framesSkippedEncoder / stats.framesAttempted : 0;

		// Encoding is only one stage of the frame's journey; once it eats most
		// of the budget on its own there is nothing left for capture, decode
		// and paint, and the stream visibly stutters.
		//
		// All three signals are deliberately generous. A ratio rather than a
		// raw count, a window peak rather than a spot sample, and a threshold
		// above the queue depth that healthy asynchronous encoding produces
		// anyway — anything tighter reports saturation on an idle host.
		const encoderSaturated =
			stats.avgFrameCostMs > frameBudgetMs * 0.8 ||
			stats.encodeQueueMax >= 4 ||
			skipRatio > 0.4;

		debug.log(
			'webcodecs',
			`enc ${sessionId}: ${stats.codec}/${stats.captureMode} ${stats.width}x${stats.height} ` +
				`${(stats.measuredFps ?? 0).toFixed(1)}/${videoSession.targetFramerate}fps ` +
				`derate=${videoSession.pixelDerate} | ` +
				`cost=${stats.avgFrameCostMs.toFixed(1)}ms/${frameBudgetMs.toFixed(0)}ms ` +
				`qMax=${stats.encodeQueueMax} skip=${(skipRatio * 100).toFixed(0)}%` +
				`${encoderSaturated ? ' SATURATED' : ''}`
		);

		this.adaptQuality(sessionId, encoderSaturated);
	}

	/**
	 * Viewer-side health. A phone that cannot decode fast enough shows exactly
	 * the same stutter with an empty network buffer and an idle encoder, so the
	 * decode queue has to close the loop back to the source.
	 */
	applyClientFeedback(sessionId: string, viewerId: string, feedback: ClientStreamFeedback): void {
		const videoSession = this.sessions.get(sessionId);
		const viewer = videoSession?.viewers.get(viewerId);
		if (!videoSession?.isActive || !viewer) return;

		// Thresholds sit well clear of healthy operation for the same reason as
		// the encoder ones: decodeQueueSize is a spot sample and dropRatio has
		// window-boundary skew, so tight limits fire on a stream that is fine.
		viewer.decoderSaturated =
			feedback.decodeQueueSize >= 4 ||
			feedback.dropRatio > 0.4 ||
			feedback.decodeLatencyMs > 300;

		// Every viewer reports on its own two-second timer, so folding each
		// report straight into the ladder would step it once per viewer per
		// window — and a healthy phone would keep cancelling out a struggling
		// laptop, since a healthy window resets the saturation counter. One
		// verdict per window, taken from the worst viewer: the stream is shared,
		// so it can only be as fast as its slowest decoder.
		const now = Date.now();
		if (now - videoSession.lastClientAdaptAt < BrowserVideoCapture.CLIENT_ADAPT_INTERVAL_MS) return;
		videoSession.lastClientAdaptAt = now;

		const anySaturated = Array.from(videoSession.viewers.values()).some(
			(entry) => entry.decoderSaturated
		);

		this.adaptQuality(sessionId, anySaturated);
	}

	/**
	 * Viewer display metrics changed (panel resize, device change, zoom, or a
	 * move to a different-density screen). Debounced because a resize drag
	 * emits a continuous stream of these.
	 */
	applyDisplayMetrics(
		sessionId: string,
		session: BrowserTab,
		viewerId: string,
		metrics: ClientDisplayMetrics
	): void {
		const videoSession = this.sessions.get(sessionId);
		const viewer = videoSession?.viewers.get(viewerId);
		if (!videoSession || !viewer) return;

		viewer.display = { ...viewer.display, ...metrics };
		this.refreshViewerConfig(videoSession);

		const existing = this.displayMetricsTimers.get(sessionId);
		if (existing) clearTimeout(existing);

		this.displayMetricsTimers.set(
			sessionId,
			setTimeout(() => {
				this.displayMetricsTimers.delete(sessionId);
				void this.applyCaptureGeometry(sessionId, session);
			}, BrowserVideoCapture.DISPLAY_METRICS_DEBOUNCE_MS)
		);
	}

	/**
	 * Pause capture while the viewer can't see it (panel collapsed, browser tab
	 * hidden). An unwatched preview otherwise keeps a headless renderer and an
	 * encoder busy for nothing — the dominant idle cost on a shared VPS.
	 */
	/**
	 * Record one viewer's visibility and pause only when nobody is watching.
	 *
	 * Visibility is per viewer: collapsing the panel on a laptop must not stop
	 * the capture a phone is still watching.
	 */
	async setViewerVisibility(
		sessionId: string,
		session: BrowserTab,
		viewerId: string,
		visible: boolean
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		const viewer = videoSession?.viewers.get(viewerId);
		if (!videoSession || !viewer) return false;

		viewer.visible = visible;
		return this.setPaused(sessionId, session, this.allViewersHidden(videoSession));
	}

	private async setPaused(sessionId: string, session: BrowserTab, paused: boolean): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive) return false;
		if (videoSession.paused === paused) return true;

		videoSession.paused = paused;
		debug.log('webcodecs', `${paused ? '⏸️ Paused' : '▶️ Resumed'} capture for ${sessionId}`);

		const feeder = this.feeders.get(sessionId);

		if (paused) {
			if (videoSession.captureMode === 'native') {
				await session.page
					?.evaluate(() => {
						(window as any).__webCodecsPeer?.stopNativeCapture();
					})
					.catch(() => {});
				videoSession.captureMode = 'push';
			}
			await feeder?.pause();
			return true;
		}

		// Resuming: rebuild whichever source is available — pausing tears the
		// native track down, so this re-probes rather than assuming the feeder
		// is still the right source — then force a sync point so the viewer
		// isn't left staring at the pre-pause frame.
		if (feeder) {
			await feeder.restart(
				videoSession.capture.width,
				videoSession.capture.height,
				videoSession.profile.screenshotQuality
			);
		} else {
			await this.setupCapture(sessionId, session, () => !session.isDestroyed);
		}

		await this.requestKeyframe(sessionId, session);
		return true;
	}

	// ------------------------------------------------------------------
	// Signaling
	// ------------------------------------------------------------------

	/**
	 * Create an offer for one viewer.
	 */
	async createOffer(
		sessionId: string,
		session: BrowserTab,
		viewerId: string
	): Promise<RTCSessionDescriptionInit | null> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page) {
			return null;
		}

		// A new offer means a new peer for this viewer, so anything the previous
		// one had accepted no longer applies: candidates must queue again until
		// the fresh peer has a remote description. Reconnecting after a page
		// navigation goes straight through here, and skipping this left the
		// viewer forwarding candidates into a peer that could not take them yet.
		//
		// A viewer reconnecting to a still-running stream arrives here without
		// going through a handshake, and may have been dropped in between (its
		// socket closed, its panel was hidden), so it is registered on demand
		// rather than being refused a peer.
		const viewer = videoSession.viewers.get(viewerId) ?? this.registerViewer(videoSession, { viewerId });
		viewer.connected = false;
		viewer.pendingCandidates = [];

		const maxRetries = 6;
		const retryDelay = 150;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				// Single evaluate: check peer + create offer in one IPC round-trip
				const offer = await session.page.evaluate(async (id: string) => {
					const peer = (window as any).__webCodecsPeer;
					if (typeof peer?.createOffer !== 'function') return null;
					return peer.createOffer(id);
				}, viewerId);

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
		viewerId: string,
		answer: RTCSessionDescriptionInit
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		const viewer = videoSession?.viewers.get(viewerId);
		if (!videoSession?.isActive || !viewer || !session.page) {
			return false;
		}

		try {
			const success = await session.page.evaluate(
				(params: { id: string; ans: RTCSessionDescriptionInit }) => {
					return (window as any).__webCodecsPeer?.handleAnswer(params.id, params.ans);
				},
				{ id: viewerId, ans: answer }
			);

			if (success) {
				viewer.connected = true;

				// Process pending ICE candidates
				for (const candidate of viewer.pendingCandidates) {
					await this.addIceCandidate(sessionId, session, viewerId, candidate);
				}
				viewer.pendingCandidates = [];
			}

			return success;
		} catch (error) {
			debug.error('webcodecs', `Handle answer error:`, error);
			return false;
		}
	}

	/**
	 * Add ICE candidate from one viewer
	 */
	async addIceCandidate(
		sessionId: string,
		session: BrowserTab,
		viewerId: string,
		candidate: RTCIceCandidateInit
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		const viewer = videoSession?.viewers.get(viewerId);
		if (!videoSession?.isActive || !viewer || !session.page) {
			return false;
		}

		// Queue until this viewer's peer has a remote description
		if (!viewer.connected) {
			viewer.pendingCandidates.push(candidate);
			return true;
		}

		try {
			return await session.page.evaluate(
				(params: { id: string; cand: RTCIceCandidateInit }) => {
					return (window as any).__webCodecsPeer?.addIceCandidate(params.id, params.cand);
				},
				{ id: viewerId, cand: candidate }
			);
		} catch (error) {
			debug.error('webcodecs', `Add ICE candidate error:`, error);
			return false;
		}
	}

	// ------------------------------------------------------------------
	// Viewport / refresh / recovery
	// ------------------------------------------------------------------

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
			debug.log('webcodecs', `🔄 Hot-swapping viewport to ${width}x${height}`);

			// The emulated viewport is what the page lays out against; capture
			// resolution is derived from it and the viewer's display metrics.
			await session.page.setViewport({ width, height });

			// Force a recompute even if the derived size happens to land close
			// to the previous one — the page content changed shape.
			videoSession.capture = { width: 0, height: 0, scale: 1 };

			return await this.applyCaptureGeometry(sessionId, session);
		} catch (error) {
			debug.error('webcodecs', `Failed to update viewport:`, error);
			return false;
		}
	}

	/**
	 * Restart capture at the current geometry.
	 * Used as a refresh/recovery path when the frontend detects a stuck stream.
	 */
	async refreshScreencast(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot refresh screencast: session not active`);
			return false;
		}

		try {
			const feeder = this.feeders.get(sessionId);
			if (feeder) {
				feeder.invalidatePeerHandle();
				await feeder.restart(
					videoSession.capture.width,
					videoSession.capture.height,
					videoSession.profile.screenshotQuality
				);
			}

			await this.requestKeyframe(sessionId, session);
			return true;
		} catch (error) {
			debug.error('webcodecs', `Failed to refresh screencast:`, error);
			return false;
		}
	}

	/**
	 * Client-driven keyframe request (PLI equivalent).
	 * Forces the next encoded frame to be a keyframe AND immediately pushes a
	 * high-quality frame through the encoder — so it works even on still pages
	 * where no capture frames are flowing. Called when the frontend decoder
	 * errors or joins mid-stream and needs a sync point.
	 */
	async requestKeyframe(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			return false;
		}

		try {
			// In native mode `forceKeyframe` re-encodes the retained compositor
			// frame in-page, so no screenshot is needed at all.
			await session.page.evaluate(() => {
				(window as any).__webCodecsPeer?.forceKeyframe();
			});

			if (videoSession.captureMode === 'push') {
				this.feeders.get(sessionId)?.scheduleTopOff();
			}

			debug.log('webcodecs', `Keyframe requested for ${sessionId}`);
			return true;
		} catch (error) {
			debug.warn('webcodecs', `Failed to request keyframe:`, error);
			return false;
		}
	}

	/**
	 * Handle navigation - re-inject peer script and restart capture
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

			debug.log('webcodecs', `🔄 Handling navigation for ${sessionId} - re-injecting peer script and restarting capture`);

			const videoConfig = this.buildVideoConfig(videoSession, viewport);
			const audioConfig = this.buildAudioConfig(videoSession);

			// Re-inject video encoder and audio capture scripts to new page context
			await page.evaluate(videoEncoderScript, videoConfig);
			await injectAudioCaptureIntoAllFrames(page, audioConfig);

			// Single batched call: verify peer + start streaming + init audio
			const initResult = await page.evaluate(async () => {
				const peer = (window as any).__webCodecsPeer;
				if (typeof peer?.startStreaming !== 'function') {
					return { peerExists: false, started: false, audioInitialized: false };
				}

				const started = await peer.startStreaming();
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
			});

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

			// The old page's encoder handle died with its execution context.
			videoSession.captureMode = 'push';
			await this.setupCapture(sessionId, session, () => !session.isDestroyed);

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

		const metricsTimer = this.displayMetricsTimers.get(sessionId);
		if (metricsTimer) {
			clearTimeout(metricsTimer);
			this.displayMetricsTimers.delete(sessionId);
		}

		await this.destroyFeeder(sessionId);

		if (session?.page && !session.page.isClosed()) {
			try {
				// Stop audio + peer in one IPC round-trip
				await session.page.evaluate(() => {
					(window as any).__audioEncoder?.stop();
					(window as any).__webCodecsPeer?.stopStreaming();
				}).catch(() => {});
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

/**
 * In-page capture is on by default and self-disables wherever it can't work
 * (insecure origin, missing API). The kill switch exists for hosts where the
 * probe itself is undesirable.
 */
function isNativeCaptureEnabled(): boolean {
	return (process.env.CLOPEN_PREVIEW_NATIVE_CAPTURE || '').trim().toLowerCase() !== 'off';
}
