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
	PeerHealth,
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
	/**
	 * When this viewer last handshook. A viewer that never reaches `connected`
	 * has to expire: entries only ever left this table on an explicit stop, a
	 * `closed`/`failed` state or a socket teardown, so a handshake that simply
	 * never completed — a host browser refreshed hard, a laptop closed
	 * mid-negotiation — stayed forever and made the session look watched.
	 */
	attachedAt: number;
}

/**
 * Per-tab injection bookkeeping.
 *
 * Deliberately *not* on the stream session: `stopStreaming` deletes that
 * record, so every stop/start cycle — i.e. every switch away from a preview
 * tab and back — believed it had never injected anything. Puppeteer's
 * `exposeFunction` then threw ("already exists") and the whole handshake
 * failed, while `evaluateOnNewDocument` happily registered another copy of
 * the audio tap that nothing ever removed. This lives as long as the tab.
 */
interface TabInjectionState {
	/** Signalling bindings installed on the page (survive navigation). */
	bindingsExposed: boolean;
	/** Identifier of the registered on-new-document audio script, if any. */
	audioScriptId: string | null;
	/** Id stamped on the most recent peer injection — compared to PeerHealth. */
	epoch: string;
	/**
	 * Codec order the injected encoder was built with. The page decides its
	 * codec once, at injection, so a viewer arriving with different decode
	 * capabilities needs a rebuild rather than a reconfigure.
	 */
	codecSignature: string;
}

interface VideoStreamSession {
	sessionId: string;
	isActive: boolean;
	paused: boolean;
	headlessReady: boolean;
	viewers: Map<string, StreamViewer>;
	scriptInjected: boolean; // Track if persistent script was injected
	scriptsPreInjected: boolean; // Track if scripts were pre-injected during tab creation
	/**
	 * When the page last reported frames reaching its encoder. A connected
	 * viewer while this stands still is watching a stream that has stopped
	 * producing — which looks identical, from the client, to a slow page.
	 */
	lastEncodedAt: number;
	/** Guards the watchdog against re-entering while a repair is in flight. */
	repairing: boolean;
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
	/** Attempts to re-deliver a still-page refresh frame before giving up. */
	private static readonly MAX_TOP_OFF_RETRIES = 3;

	private ackTimer: ReturnType<typeof setTimeout> | null = null;
	private topOffTimer: ReturnType<typeof setTimeout> | null = null;
	private topOffRetries = 0;
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
	private dispatch(data: string, isTopOff: boolean, mimeType: string): boolean {
		if (this.destroyed) return false;

		if (!this.peerObjectId) {
			void this.acquirePeerHandle();
			return false;
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

		return true;
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
			if (this.dispatch(event.data, false, 'image/jpeg')) this.topOffRetries = 0;
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

				const sent = this.dispatch(
					screenshot.data,
					true,
					profile.topOffFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
				);

				// A dropped top-off used to be the end of the line. The encoder
				// handle goes stale on every navigation and re-injection, and the
				// screencast only fires on damage — so on a page that is not
				// moving (a preview the user has just come back to) the one frame
				// that would have cleared "Loading preview…" was lost and nothing
				// would ever produce another. Retry while the handle is being
				// re-acquired, then give up rather than spin.
				if (!sent && this.topOffRetries < ScreencastFeeder.MAX_TOP_OFF_RETRIES) {
					this.topOffRetries++;
					this.capturingTopOff = false;
					this.scheduleTopOff();
					return;
				}
				this.topOffRetries = 0;
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
		this.topOffRetries = 0;

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

	/**
	 * How long a viewer may sit in the table without ever connecting.
	 * Generous — a slow network can take seconds to finish ICE — but finite,
	 * which is the point: a viewer that never completes must not keep the
	 * session looking watched forever.
	 */
	private static readonly VIEWER_HANDSHAKE_TTL_MS = 45_000;

	/**
	 * Silence tolerated from a connected viewer's stream before the watchdog
	 * repairs it. Two encoder-stat windows plus slack — long enough that a
	 * genuinely idle page (which still tops off) never trips it.
	 */
	private static readonly STREAM_STALL_MS = 6_000;

	private sessions = new Map<string, VideoStreamSession>();
	private feeders = new Map<string, ScreencastFeeder>();
	private preInjectPromises = new Map<string, Promise<boolean>>();
	private displayMetricsTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Injection bookkeeping, per tab — outlives the stream session. */
	private tabInjection = new Map<string, TabInjectionState>();
	private epochCounter = 0;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		super();
	}

	/** Injection bookkeeping for a tab, created on first use. */
	private injectionState(sessionId: string): TabInjectionState {
		let state = this.tabInjection.get(sessionId);
		if (!state) {
			state = { bindingsExposed: false, audioScriptId: null, epoch: '', codecSignature: '' };
			this.tabInjection.set(sessionId, state);
		}
		return state;
	}

	private nextEpoch(sessionId: string): string {
		return `${sessionId}:${++this.epochCounter}:${Date.now().toString(36)}`;
	}

	/**
	 * Forget everything remembered about a tab. Called when the tab is closed —
	 * its page is gone, so the bindings and on-new-document scripts go with it.
	 */
	disposeTab(sessionId: string): void {
		this.tabInjection.delete(sessionId);
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
			epoch: this.injectionState(videoSession.sessionId).epoch,
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
			lastEncodedAt: 0,
			repairing: false,
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

			await this.injectScripts(sessionId, page, videoSession, viewport);

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
	 * Expose the signalling bindings, once per tab.
	 *
	 * Every one of these is bound to the tab whose page it was injected into.
	 * They used to resolve their session by picking the first active one in
	 * the whole project, which is correct only while exactly one tab streams:
	 * with several open, one page's ICE candidates, connection states, cursor
	 * and encoder stats were all attributed to a different tab.
	 *
	 * Whether they are already installed is remembered here rather than probed
	 * from the page. `typeof window.__sendIceCandidate === 'function'` describes
	 * the *current document*, and Puppeteer re-installs bindings on each new
	 * one — so mid-navigation the probe says "absent" while Puppeteer's own
	 * registry says "present", and `exposeFunction` throws. That threw out of
	 * the whole handshake, and every client retry hit the same window: the
	 * preview sat on "Loading preview…" until something else moved the page.
	 */
	private async exposeBindings(sessionId: string, page: Page): Promise<void> {
		const state = this.injectionState(sessionId);
		if (state.bindingsExposed) return;

		/** Already-registered is success, not failure — see above. */
		const expose = async (name: string, fn: (...args: any[]) => void) => {
			try {
				await page.exposeFunction(name, fn);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes('already exists')) throw error;
			}
		};

		await expose('__sendIceCandidate', (viewerId: string, candidate: RTCIceCandidateInit) => {
			this.emit('ice-candidate', { sessionId, viewerId, candidate, from: 'headless' });
		});

		await expose('__sendConnectionState', (viewerId: string, state: string) => {
			const videoSession = this.sessions.get(sessionId);
			if (!videoSession) return;

			videoSession.stats.connectionState = state;
			this.emit('connection-state', { sessionId, viewerId, state });

			const viewer = videoSession.viewers.get(viewerId);
			if (viewer && state === 'connected') viewer.connected = true;

			// Capture sources only produce frames on damage, so a viewer
			// that connects to an already-still page would otherwise wait
			// for the first mouse move to see anything. Push one refresh
			// frame as soon as the peer is up.
			if (state === 'connected' && videoSession.tab) {
				videoSession.lastEncodedAt = Date.now();
				void this.requestKeyframe(sessionId, videoSession.tab);
			}

			if (state === 'closed' || state === 'failed') {
				videoSession.viewers.delete(viewerId);
			}
		});

		// A channel that has just opened has no frame to show yet on a still
		// page — see the matching comment in video-stream.ts.
		await expose('__requestRefreshFrame', (viewerId: string) => {
			const videoSession = this.sessions.get(sessionId);
			if (!videoSession?.tab) return;
			debug.log('webcodecs', `Refresh frame requested by viewer ${viewerId} on ${sessionId}`);
			void this.requestKeyframe(sessionId, videoSession.tab);
		});

		await expose('__sendCursorChange', (cursor: string) => {
			this.emit('cursor-change', { sessionId, cursor });
		});

		await expose('__sendEncoderStats', (stats: EncoderStats) => {
			this.applyEncoderStats(sessionId, stats);
		});

		state.bindingsExposed = true;
	}

	/**
	 * Inject signalling bindings + encoder scripts into the page.
	 *
	 * Mints a fresh epoch for the peer object it creates, so a later health
	 * check can tell this injection apart from one left behind by a document
	 * the page has since navigated away from.
	 */
	private async injectScripts(
		sessionId: string,
		page: Page,
		videoSession: VideoStreamSession,
		viewport: { width: number; height: number }
	): Promise<void> {
		await this.exposeBindings(sessionId, page);

		const state = this.injectionState(sessionId);
		const audioConfig = this.buildAudioConfig(videoSession);

		// Register audio capture as a startup script — runs before page scripts on
		// every new document load. Critical for SPAs that create AudioContext
		// during initialization (before page.evaluate runs).
		//
		// Registered exactly once for the tab. This used to be tracked on the
		// stream session, which `stopStreaming` deletes, so every switch away
		// from a preview tab and back added another copy that nothing removed —
		// after enough switches each page load ran a stack of them, and the only
		// cure was restarting the server.
		if (!state.audioScriptId) {
			const registered = await page.evaluateOnNewDocument(audioCaptureScript, audioConfig);
			state.audioScriptId = (registered as { identifier?: string })?.identifier ?? 'registered';
		}

		state.epoch = this.nextEpoch(sessionId);

		// Inject video encoder + audio capture scripts into the current page context
		const videoConfig = this.buildVideoConfig(videoSession, viewport);
		state.codecSignature = this.codecSignature(videoSession);

		await page.evaluate(videoEncoderScript, videoConfig);
		await injectAudioCaptureIntoAllFrames(page, audioConfig);
	}

	/** Which encoder candidates the current viewer set implies. */
	private codecSignature(videoSession: VideoStreamSession): string {
		return resolveCodecCandidates(videoSession.codecSupport)
			.map((candidate) => candidate.name)
			.join(',');
	}

	// ------------------------------------------------------------------
	// Liveness
	// ------------------------------------------------------------------

	/** What the page says about its own peer, or null when it has none. */
	private async readPeerHealth(page: Page): Promise<PeerHealth | null> {
		if (page.isClosed()) return null;
		try {
			return await page.evaluate(() => {
				const peer = (window as any).__webCodecsPeer;
				return typeof peer?.health === 'function' ? peer.health() : null;
			});
		} catch {
			// Execution context torn down mid-navigation — treat as "no peer",
			// which is exactly what it will be a moment from now.
			return null;
		}
	}

	/**
	 * Bring the page's capture in line with what the backend believes.
	 *
	 * This replaces the old fork in `startStreaming`, which chose between a
	 * clean restart and a bare attach purely on how many *other* viewers were
	 * registered. That choice was made from the backend's own record, and the
	 * record is exactly the thing that goes stale: with another viewer present
	 * the attach path never re-injected the peer script, so a page whose peer
	 * had died with a navigation stayed dead, `createOffer` returned null
	 * forever, and every client retry took the same doomed branch. Reloading
	 * the page was the only way out, because that re-injected by another route.
	 *
	 * Asking the page instead makes both cases converge: cheap when it is
	 * healthy (one evaluate), correct when it is not.
	 */
	private async ensureLive(
		sessionId: string,
		session: BrowserTab,
		isValidSession: () => boolean,
		options: { force?: boolean } = {}
	): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession) return false;
		if (!session.page || session.page.isClosed()) return false;

		const page = session.page;
		const viewport = page.viewport()!;
		videoSession.tab = session;

		const health = options.force ? null : await this.readPeerHealth(page);
		const injection = this.injectionState(sessionId);

		// A peer from a different injection answers every call and encodes into
		// a page that is no longer on screen — indistinguishable from a healthy
		// one without the epoch.
		const epochMismatch = !health || !health.epoch || health.epoch !== injection.epoch;
		const codecChanged = injection.codecSignature !== this.codecSignature(videoSession);
		const needsInjection = epochMismatch || codecChanged;

		if (needsInjection) {
			const reason = options.force
				? 'forced'
				: !health
					? 'no peer in page'
					: epochMismatch
						? 'epoch mismatch'
						: 'codec set changed';
			debug.log('webcodecs', `Rebuilding peer for ${sessionId} (${reason})`);
			await this.injectScripts(sessionId, page, videoSession, viewport);
			videoSession.scriptInjected = true;
			// The old page's encoder handle died with its execution context.
			this.feeders.get(sessionId)?.invalidatePeerHandle();
		}

		if (needsInjection || !health?.capturing) {
			const started = await this.startPageCapture(page);
			if (!started) {
				debug.error('webcodecs', `Page refused to start capturing for ${sessionId}`);
				return false;
			}
			videoSession.isActive = true;
			videoSession.headlessReady = true;
			videoSession.paused = false;
			videoSession.captureMode = 'push';
			videoSession.healthyWindows = 0;
			await this.setupCapture(sessionId, session, isValidSession);
		} else {
			// Healthy: keep the backend's view of the page honest anyway, since
			// the page may have switched capture source on its own.
			videoSession.isActive = true;
			videoSession.headlessReady = true;
			videoSession.captureMode = health.captureMode;
			this.reconcileViewers(videoSession, health);
		}

		videoSession.lastEncodedAt = Date.now();
		this.ensureWatchdog();
		return true;
	}

	/**
	 * Start (or confirm) the page-side encoder and audio tap in one round-trip.
	 */
	private async startPageCapture(page: Page): Promise<boolean> {
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

		if (!initResult.peerExists || !initResult.started) return false;

		if (!initResult.audioInitialized) {
			debug.warn('webcodecs', 'Audio not available, continuing with video only');
		}

		return true;
	}

	/**
	 * Drop viewers the page has never heard of and handshakes that never
	 * completed. Without this a viewer that vanished mid-negotiation — a host
	 * browser refreshed, a laptop closed — stayed in the table forever, and the
	 * session went on looking watched by an audience of nobody.
	 */
	private reconcileViewers(videoSession: VideoStreamSession, health: PeerHealth): void {
		const livePeers = new Set(health.viewers);
		const now = Date.now();
		let dropped = 0;

		for (const [viewerId, viewer] of videoSession.viewers) {
			if (livePeers.has(viewerId)) continue;
			// Still negotiating — its peer is created by createOffer, which may
			// not have run yet.
			if (now - viewer.attachedAt < BrowserVideoCapture.VIEWER_HANDSHAKE_TTL_MS) continue;

			videoSession.viewers.delete(viewerId);
			dropped++;
		}

		if (dropped > 0) {
			debug.log(
				'webcodecs',
				`Dropped ${dropped} stale viewer(s) from ${videoSession.sessionId}, ${videoSession.viewers.size} left`
			);
			this.refreshViewerConfig(videoSession);
		}
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
			decoderSaturated: false,
			attachedAt: Date.now()
		};

		if (options.codecSupport) viewer.codecSupport = options.codecSupport;
		if (options.display) viewer.display = { ...viewer.display, ...options.display };
		// A fresh handshake means a fresh peer: whatever ICE was queued for the
		// previous one belongs to a connection that no longer exists.
		viewer.connected = false;
		viewer.pendingCandidates = [];
		viewer.visible = true;
		viewer.attachedAt = Date.now();

		videoSession.viewers.set(viewer.id, viewer);
		this.refreshViewerConfig(videoSession);

		return viewer;
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
	 * Attach a viewer to a tab's stream, bringing the stream up if it isn't.
	 *
	 * One path for both cases. The old code chose between "restart everything"
	 * and "just attach" from its own viewer count, which meant a stale entry
	 * could route a perfectly ordinary reconnect into the attach branch and
	 * leave a dead page untouched. Here the page decides (see `ensureLive`),
	 * and the difference between a first viewer and a fifth is only how much
	 * work that check turns out to imply.
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

		if (!session.page || session.page.isClosed()) {
			debug.error('webcodecs', `Cannot start: page is closed`);
			return false;
		}

		try {
			let videoSession = this.sessions.get(sessionId);
			if (!videoSession) {
				videoSession = this.createSessionState(sessionId);
				this.sessions.set(sessionId, videoSession);
			}

			videoSession.tab = session;
			this.registerViewer(videoSession, options);

			// The pre-injected peer was built before any viewer's capabilities
			// were known; `ensureLive` re-injects if this one needs a different
			// codec set, and reuses it otherwise. Display metrics never need a
			// rebuild — `applyCaptureGeometry` reconfigures the live encoder.
			const live = await this.ensureLive(sessionId, session, isValidSession);

			if (!live) {
				debug.error('webcodecs', `Failed to bring up capture for ${sessionId}`);
				return false;
			}

			// Someone is watching again — the stream may have been paused because
			// everyone who had it open put it off screen.
			await this.setPaused(sessionId, session, false);
			await this.applyCaptureGeometry(sessionId, session);

			debug.log(
				'webcodecs',
				`Streaming ready for ${sessionId} — ${videoSession.capture.width}x${videoSession.capture.height} ` +
					`@${videoSession.targetFramerate}fps (${videoSession.captureMode}, ${videoSession.profile.tier}, ` +
					`${videoSession.viewers.size} viewer(s))`
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
	 * Watch every live session for a stream that has stopped producing.
	 *
	 * On a timer rather than driven by encoder stats, because the failures that
	 * matter are the ones where the page stops reporting altogether — a peer
	 * that died with a navigation sends nothing, so anything event-driven would
	 * wait forever for a signal that is never coming. Runs only while sessions
	 * exist, and does nothing at all unless one has actually gone quiet.
	 */
	private ensureWatchdog(): void {
		if (this.watchdogTimer || this.sessions.size === 0) return;

		this.watchdogTimer = setInterval(() => {
			if (this.sessions.size === 0) {
				clearInterval(this.watchdogTimer!);
				this.watchdogTimer = null;
				return;
			}

			for (const videoSession of [...this.sessions.values()]) {
				if (!videoSession.isActive) continue;
				if (this.reapStaleViewers(videoSession)) continue;
				this.checkForStall(videoSession);
			}
		}, BrowserVideoCapture.STREAM_STALL_MS);

		// Nothing here should hold the process open on its own.
		this.watchdogTimer.unref?.();
	}

	/**
	 * Drop viewers that handshook and never connected, and tear the capture
	 * down if that leaves nobody watching. Returns whether the session ended.
	 *
	 * The page-informed pass in `reconcileViewers` only runs when someone
	 * handshakes, which is precisely what a tab nobody is watching any more
	 * never gets — so without this a viewer that vanished mid-negotiation kept
	 * a headless renderer and an encoder busy for an audience of nobody.
	 */
	private reapStaleViewers(videoSession: VideoStreamSession): boolean {
		const now = Date.now();
		let dropped = 0;

		for (const [viewerId, viewer] of videoSession.viewers) {
			if (viewer.connected) continue;
			if (now - viewer.attachedAt < BrowserVideoCapture.VIEWER_HANDSHAKE_TTL_MS) continue;

			videoSession.viewers.delete(viewerId);
			dropped++;
		}

		if (dropped === 0) return false;

		debug.log(
			'webcodecs',
			`Reaped ${dropped} viewer(s) that never connected on ${videoSession.sessionId}, ` +
				`${videoSession.viewers.size} left`
		);

		if (videoSession.viewers.size > 0) {
			this.refreshViewerConfig(videoSession);
			return false;
		}

		void this.stopStreaming(videoSession.sessionId, videoSession.tab);
		return true;
	}

	/**
	 * Repair a stream that has stopped producing while someone is watching it.
	 *
	 * Recovery used to live entirely in the viewer: it noticed no first frame,
	 * asked for a screencast refresh, then re-handshook. That only works while
	 * the *client's* view of the problem is right — and the failures that stuck
	 * were the ones where the client did everything correctly and the source
	 * was the broken half. Repairing from here closes that gap, and costs
	 * nothing on a healthy stream because even an idle page still tops off.
	 */
	private checkForStall(videoSession: VideoStreamSession): void {
		if (videoSession.paused || videoSession.repairing || !videoSession.tab) return;
		if (videoSession.viewers.size === 0) return;
		if (!Array.from(videoSession.viewers.values()).some((viewer) => viewer.connected)) return;

		const silentFor = Date.now() - videoSession.lastEncodedAt;
		if (videoSession.lastEncodedAt === 0 || silentFor < BrowserVideoCapture.STREAM_STALL_MS) return;

		const { sessionId, tab } = videoSession;
		debug.warn('webcodecs', `Stream for ${sessionId} produced nothing for ${silentFor}ms — repairing`);

		videoSession.repairing = true;
		void this.ensureLive(sessionId, tab, () => !tab.isDestroyed)
			.then((live) => {
				if (live) return this.requestKeyframe(sessionId, tab);
			})
			.catch((error) => debug.warn('webcodecs', `Stall repair failed for ${sessionId}:`, error))
			.finally(() => {
				videoSession.repairing = false;
				videoSession.lastEncodedAt = Date.now();
			});
	}

	/**
	 * Encoder health from the page. Saturation here means this host cannot
	 * produce frames fast enough, which no amount of network headroom fixes.
	 */
	private applyEncoderStats(sessionId: string, stats: EncoderStats): void {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive) return;

		videoSession.captureMode = stats.captureMode || videoSession.captureMode;

		// Frames reaching the encoder is the one signal that means the pipeline
		// is genuinely alive end to end. The counter is per-window, so any
		// non-zero report is proof of life for this window.
		if (stats.framesAttempted > 0) videoSession.lastEncodedAt = Date.now();

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
		if (!videoSession) return false;

		// Registered on demand rather than refused. A viewer whose peer failed
		// while it was suspended loses its entry, and coming back is exactly
		// when it needs one: refusing left the tab paused with `isActive` true
		// and nobody in the table, and nothing else ever re-evaluated that.
		const viewer =
			videoSession.viewers.get(viewerId) ?? this.registerViewer(videoSession, { viewerId });

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
	 * Re-establish capture after the page swapped documents.
	 *
	 * The peer object lived in the old execution context, so it is gone; only
	 * the exposed bindings survive. `ensureLive` already knows how to notice
	 * that and rebuild, and routing through it means a navigation and a stalled
	 * stream heal by the same code — a failure here no longer leaves the
	 * session marked active with a dead page behind it, which is the state that
	 * used to be unrecoverable without reloading by hand.
	 */
	async handleNavigation(sessionId: string, session: BrowserTab): Promise<boolean> {
		const videoSession = this.sessions.get(sessionId);
		if (!videoSession?.isActive || !session.page || session.page.isClosed()) {
			debug.warn('webcodecs', `Cannot handle navigation: session not active`);
			return false;
		}

		debug.log('webcodecs', `🔄 Handling navigation for ${sessionId} — rebuilding page capture`);

		try {
			const live = await this.ensureLive(sessionId, session, () => !session.isDestroyed, {
				force: true
			});

			if (!live) {
				// Leave the session marked inactive so the next handshake starts
				// from scratch instead of attaching to a page that cannot encode.
				videoSession.isActive = false;
				debug.error('webcodecs', `Failed to restore streaming after navigation for ${sessionId}`);
				return false;
			}

			// Emit event to notify frontend that streaming is ready
			this.emit('navigation-streaming-ready', { sessionId });

			return true;
		} catch (error) {
			videoSession.isActive = false;
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

		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}

		const sessionIds = Array.from(this.sessions.keys());
		await Promise.all(sessionIds.map((id) => this.stopStreaming(id)));

		this.sessions.clear();
		this.tabInjection.clear();
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
