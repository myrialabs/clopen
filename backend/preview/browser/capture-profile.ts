/**
 * Preview Capture Profile
 *
 * Single source of truth for "how much work is this host allowed to do per
 * frame". Every expensive stage of the preview pipeline — Chrome's screencast
 * JPEG encode, the in-page VideoEncoder, the wire, and the viewer's decoder —
 * scales with `pixels × framerate`, so both are budgeted here instead of being
 * hard-coded at each call site.
 *
 * Two independent mechanisms feed into the final capture size:
 *
 * 1. **Display-matched resolution** (`computeCaptureSize`). The preview is
 *    almost always displayed smaller than the emulated viewport (a 1440×900
 *    laptop preview shown in a half-width panel). Capturing at the full
 *    viewport means encoding ~5× more pixels than the screen can show. We
 *    capture at `displayScale × devicePixelRatio` instead, which is exactly
 *    one captured pixel per physical screen pixel — sharper is impossible to
 *    see, so this costs nothing visually. On a Retina display at 50% fit the
 *    factor is 0.5 × 2 = 1.0 and we capture natively, exactly as before.
 *
 * 2. **Host budget** (`getHostCaptureProfile`). A 2-core VPS cannot software-
 *    encode 1080p24 in realtime no matter how large the panel is, so the tier
 *    caps total pixels, framerate, and quality. The runtime ladder in
 *    BrowserVideoCapture adapts within these bounds.
 */

import os from 'os';
import { debug } from '$shared/utils/logger';

export type QualityTier = 'high' | 'balanced' | 'low';

export interface CaptureProfile {
	tier: QualityTier;
	/** Hard ceiling on captured pixels per frame (width × height). */
	maxPixels: number;
	/** Upper bound of the adaptive framerate ladder. */
	maxFramerate: number;
	/** Lower bound — below this, motion stops reading as motion. */
	minFramerate: number;
	/** VP9 per-frame quantizer while the page is moving (higher = cheaper). */
	motionQuantizer: number;
	/** VP9 quantizer for the still-page refresh frame (lower = sharper). */
	topOffQuantizer: number;
	/** JPEG quality of CDP screencast source frames. */
	screenshotQuality: number;
	/**
	 * Still-page refresh capture format. PNG is lossless but costs a full
	 * raster + deflate pass and produces multi-megabyte base64 payloads;
	 * JPEG at high quality is visually equivalent for UI text at a fraction
	 * of the CPU on both ends.
	 */
	topOffFormat: 'png' | 'jpeg';
	topOffQuality: number;
	audioBitrate: number;
}

const PROFILES: Record<QualityTier, Omit<CaptureProfile, 'tier'>> = {
	high: {
		maxPixels: 1920 * 1080,
		// 24 was inherited from the fixed-rate era, where every frame cost a
		// JPEG encode and a base64 round-trip. In-page capture hands compositor
		// frames straight to the encoder, so the headroom now goes to motion
		// smoothness — which is the difference the eye actually notices.
		maxFramerate: 30,
		minFramerate: 10,
		motionQuantizer: 38,
		topOffQuantizer: 10,
		screenshotQuality: 80,
		topOffFormat: 'jpeg',
		topOffQuality: 95,
		audioBitrate: 128_000
	},
	balanced: {
		maxPixels: 1440 * 900,
		maxFramerate: 20,
		minFramerate: 8,
		motionQuantizer: 42,
		topOffQuantizer: 14,
		screenshotQuality: 72,
		topOffFormat: 'jpeg',
		topOffQuality: 92,
		audioBitrate: 96_000
	},
	low: {
		maxPixels: 1280 * 720,
		maxFramerate: 12,
		minFramerate: 6,
		motionQuantizer: 48,
		topOffQuantizer: 20,
		screenshotQuality: 65,
		topOffFormat: 'jpeg',
		topOffQuality: 88,
		audioBitrate: 64_000
	}
};

/**
 * Discrete capture scales. Every change reconfigures the encoder and forces a
 * keyframe, so a continuous scale would thrash on every resize pixel. Snapping
 * to a short ladder keeps reconfigurations rare while staying within ~15% of
 * the ideal resolution.
 */
const CAPTURE_SCALE_STEPS = [0.25, 0.35, 0.5, 0.6, 0.75, 0.85, 1] as const;

/** Below this the preview stops being readable regardless of panel size. */
const MIN_CAPTURE_WIDTH = 360;

let cachedProfile: CaptureProfile | null = null;

function detectTier(): QualityTier {
	const override = (process.env.CLOPEN_PREVIEW_QUALITY || '').trim().toLowerCase();
	if (override === 'high' || override === 'balanced' || override === 'low') {
		return override;
	}

	// os.cpus() can return an empty array in some containers — treat unknown
	// as constrained rather than assuming a fast host.
	const cores = os.cpus()?.length || 2;
	const memGb = os.totalmem() / 1024 ** 3;

	if (cores <= 2 || memGb < 2.5) return 'low';
	if (cores <= 4 || memGb < 6) return 'balanced';
	return 'high';
}

/**
 * Host capability tier. Cached — hardware doesn't change at runtime, and the
 * per-session ladder handles transient load.
 */
export function getHostCaptureProfile(): CaptureProfile {
	if (cachedProfile) return cachedProfile;

	const tier = detectTier();
	cachedProfile = { tier, ...PROFILES[tier] };

	debug.log(
		'webcodecs',
		`Capture profile: ${tier} (${os.cpus()?.length || '?'} cores, ` +
			`${(os.totalmem() / 1024 ** 3).toFixed(1)} GB, ${os.platform()}) — ` +
			`≤${(cachedProfile.maxPixels / 1e6).toFixed(2)}MP @ ${cachedProfile.maxFramerate}fps`
	);

	return cachedProfile;
}

function evenRound(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

export interface CaptureSize {
	width: number;
	height: number;
	/** Effective scale relative to the emulated viewport (for CDP clip). */
	scale: number;
}

/**
 * Resolve the capture resolution for a viewport.
 *
 * `displayScale` is the CSS fit-scale the frontend applies to the preview and
 * `devicePixelRatio` is the viewer's screen density; their product is how many
 * physical screen pixels each viewport pixel actually occupies. Capturing above
 * that is invisible work; capturing below it is the upscaling blur this
 * pipeline was rewritten to remove — so the product is the target, clamped to
 * [floor, native] and to the host's pixel budget.
 */
export function computeCaptureSize(
	viewportWidth: number,
	viewportHeight: number,
	displayScale: number | undefined,
	devicePixelRatio: number | undefined,
	profile: CaptureProfile
): CaptureSize {
	// Unknown display metrics (first frame, headless MCP use) → capture native
	// and let the client's first metrics report narrow it down.
	const fit = displayScale && displayScale > 0 ? Math.min(1, displayScale) : 1;
	const dpr = devicePixelRatio && devicePixelRatio > 0 ? Math.min(4, devicePixelRatio) : 1;

	const wanted = Math.min(1, fit * dpr);
	const step = CAPTURE_SCALE_STEPS.find((s) => s >= wanted - 0.001) ?? 1;

	// Width leads and height follows the viewport's exact aspect ratio.
	// Rounding both independently drifts the aspect, and the screencast — which
	// always preserves the viewport ratio — then delivers frames a pixel or two
	// away from what was asked for, on every single restart.
	const aspect = viewportHeight / viewportWidth;
	let width = evenRound(viewportWidth * step);

	// Host budget — shrink so the frame fits the pixel ceiling.
	if (width * (width * aspect) > profile.maxPixels) {
		width = evenRound(Math.sqrt(profile.maxPixels / aspect));
	}

	// Readability floor, but never above the emulated viewport itself.
	if (width < MIN_CAPTURE_WIDTH) {
		width = evenRound(Math.min(viewportWidth, MIN_CAPTURE_WIDTH));
	}

	width = Math.min(evenRound(width), evenRound(viewportWidth));
	const height = Math.min(evenRound(width * aspect), evenRound(viewportHeight));

	return { width, height, scale: width / viewportWidth };
}

/**
 * Bits-per-pixel target for codecs driven by bitrate rather than a per-frame
 * quantizer (VP8 fallback, H.264). 0.045 bpp ≈ 1.1 Mbps at 1280×800@24.
 */
const BITS_PER_PIXEL = 0.045;

export function computeBitrate(width: number, height: number, framerate: number): number {
	return Math.max(400_000, Math.round(width * height * framerate * BITS_PER_PIXEL));
}
