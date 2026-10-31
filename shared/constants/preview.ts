// Preview Configuration
// Centralized configuration for preview components

/**
 * What the page is shown on.
 *
 * Four of these are device classes, each with a set of device models to pick
 * from and a mockup drawn around the page. `responsive` is the fifth: no
 * mockup and no fixed size — the viewport is whatever the user drags it to,
 * the way a desktop browser window is.
 */
export const DEVICE_SIZES = ['desktop', 'laptop', 'tablet', 'mobile', 'responsive'] as const;

export type DeviceSize = (typeof DEVICE_SIZES)[number];
export type Rotation = 'portrait' | 'landscape';

export interface ViewportSize {
	width: number;
	height: number;
}

/**
 * The default size of each device class, in CSS pixels.
 *
 * Desktop and laptop are naturally landscape (width > height); tablet and
 * mobile are naturally portrait. Picking a class without a model lands here.
 */
export const DEVICE_VIEWPORTS: Record<DeviceSize, ViewportSize> = {
	desktop: { width: 1920, height: 1080 }, // FHD — still the most common desktop monitor
	laptop: { width: 1440, height: 900 }, // Modern 13" MacBook Air / 16:10 laptop
	tablet: { width: 834, height: 1194 }, // iPad Pro 11" M4 class
	mobile: { width: 402, height: 874 }, // iPhone 16 / modern flagship phone
	responsive: { width: 1280, height: 800 }
};

/**
 * The range a viewport may be set to.
 *
 * The floor is below any real phone so narrow breakpoints can still be
 * reached; the ceiling is 4K, past which the capture has nothing more to give.
 */
export const VIEWPORT_LIMITS = { min: 200, max: 3840 } as const;

/** The system whose UI is drawn around the page — status bar, menu bar, taskbar. */
export type DeviceOs = 'ios' | 'ipados' | 'android' | 'macos' | 'windows';

export interface DevicePreset {
	/** Stable id; also how a tab names the device it is shown on. */
	id: string;
	label: string;
	deviceSize: Exclude<DeviceSize, 'responsive'>;
	os: DeviceOs;
	/** In the class's natural orientation. */
	width: number;
	height: number;
}

/**
 * Device models, grouped by class.
 *
 * Each is its own piece of hardware with its own mockup — an iPhone 16 and a
 * Galaxy S24 are both phones, but they do not look alike and the preview
 * should not pretend they do. The first model of each class is that class's
 * default and must match `DEVICE_VIEWPORTS`.
 */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
	{ id: 'monitor-fhd', label: 'Monitor 24" FHD', deviceSize: 'desktop', os: 'windows', width: 1920, height: 1080 },
	{ id: 'studio-display', label: 'Studio Display', deviceSize: 'desktop', os: 'macos', width: 2560, height: 1440 },
	{ id: 'monitor-hd', label: 'Monitor HD', deviceSize: 'desktop', os: 'windows', width: 1280, height: 720 },

	{ id: 'macbook-air-13', label: 'MacBook Air 13"', deviceSize: 'laptop', os: 'macos', width: 1440, height: 900 },
	{ id: 'macbook-pro-16', label: 'MacBook Pro 16"', deviceSize: 'laptop', os: 'macos', width: 1728, height: 1117 },
	{ id: 'windows-laptop', label: 'Windows Laptop', deviceSize: 'laptop', os: 'windows', width: 1366, height: 768 },

	{ id: 'ipad-pro-11', label: 'iPad Pro 11"', deviceSize: 'tablet', os: 'ipados', width: 834, height: 1194 },
	{ id: 'ipad-pro-13', label: 'iPad Pro 13"', deviceSize: 'tablet', os: 'ipados', width: 1032, height: 1376 },
	{ id: 'ipad-mini', label: 'iPad mini', deviceSize: 'tablet', os: 'ipados', width: 744, height: 1133 },
	{ id: 'galaxy-tab-s9', label: 'Galaxy Tab S9', deviceSize: 'tablet', os: 'android', width: 800, height: 1280 },

	{ id: 'iphone-16', label: 'iPhone 16', deviceSize: 'mobile', os: 'ios', width: 402, height: 874 },
	{ id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', deviceSize: 'mobile', os: 'ios', width: 440, height: 956 },
	{ id: 'iphone-se', label: 'iPhone SE', deviceSize: 'mobile', os: 'ios', width: 375, height: 667 },
	{ id: 'pixel-9', label: 'Pixel 9', deviceSize: 'mobile', os: 'android', width: 412, height: 923 },
	{ id: 'galaxy-s24', label: 'Galaxy S24', deviceSize: 'mobile', os: 'android', width: 360, height: 780 }
];

export const DEVICE_MODEL_IDS = DEVICE_PRESETS.map((preset) => preset.id) as [string, ...string[]];

export function isDeviceSize(value: unknown): value is DeviceSize {
	return typeof value === 'string' && (DEVICE_SIZES as readonly string[]).includes(value);
}

export function getDevicePreset(id: string | null | undefined): DevicePreset | undefined {
	return id ? DEVICE_PRESETS.find((preset) => preset.id === id) : undefined;
}

/**
 * The model a tab is shown on: the one it names, when that model belongs to
 * its class; otherwise the class default. Responsive has none.
 */
export function resolveDevicePreset(deviceSize: DeviceSize, deviceModel?: string | null): DevicePreset | undefined {
	if (deviceSize === 'responsive') return undefined;
	const named = getDevicePreset(deviceModel);
	if (named && named.deviceSize === deviceSize) return named;
	return DEVICE_PRESETS.find((preset) => preset.deviceSize === deviceSize);
}

/** Held devices stand up; ones you sit in front of lie down. */
export function defaultRotation(deviceSize: DeviceSize): Rotation {
	return deviceSize === 'tablet' || deviceSize === 'mobile' ? 'portrait' : 'landscape';
}

/**
 * Whether a class can be turned. Phones and tablets turn in the hand and a
 * monitor pivots on its stand, but a laptop's screen is hinged to its
 * keyboard — a portrait laptop is not a thing anyone has seen.
 */
export function canRotate(deviceSize: DeviceSize): boolean {
	return deviceSize !== 'laptop';
}

/** A square counts as portrait, which is what the frames are drawn for. */
export function orientationOf(size: ViewportSize): Rotation {
	return size.width > size.height ? 'landscape' : 'portrait';
}

/** The same size turned to face the given way. */
export function orient(size: ViewportSize, rotation: Rotation): ViewportSize {
	const larger = Math.max(size.width, size.height);
	const smaller = Math.min(size.width, size.height);
	return rotation === 'portrait'
		? { width: smaller, height: larger }
		: { width: larger, height: smaller };
}

export function clampViewport(size: ViewportSize): ViewportSize {
	const clamp = (value: number) =>
		Math.round(Math.min(VIEWPORT_LIMITS.max, Math.max(VIEWPORT_LIMITS.min, Number(value) || 0)));
	return { width: clamp(size.width), height: clamp(size.height) };
}

/**
 * Get viewport dimensions based on device size and rotation — the class
 * default, ignoring any size the tab was set to.
 *
 * SIMPLE RULE:
 * - Portrait: height > width (vertical orientation)
 * - Landscape: width > height (horizontal orientation)
 */
export function getViewportDimensions(deviceSize: DeviceSize, rotation: Rotation): ViewportSize {
	return orient(DEVICE_VIEWPORTS[deviceSize] ?? DEVICE_VIEWPORTS.laptop, rotation);
}

/**
 * The size a tab's page is laid out at.
 *
 * A tab carries its own size once anyone has picked one — a model, a typed
 * W×H, a drag. Before that, and for anything persisted before tabs carried a
 * size at all, the class default stands in.
 */
export function resolveViewport(
	deviceSize: DeviceSize,
	rotation: Rotation,
	viewport?: Partial<ViewportSize> | null
): ViewportSize {
	if (viewport && Number(viewport.width) > 0 && Number(viewport.height) > 0) {
		return clampViewport(viewport as ViewportSize);
	}
	return getViewportDimensions(deviceSize, rotation);
}

/** A model's own size, turned to face the given way. */
export function presetViewport(preset: DevicePreset, rotation: Rotation): ViewportSize {
	return orient(preset, rotation);
}

/** What a tab is shown on. */
export interface DeviceState {
	deviceSize: DeviceSize;
	rotation: Rotation;
	viewport: ViewportSize;
	/** Null for responsive. */
	deviceModel: string | null;
}

/**
 * A change of device. Anything left out is carried over from the current
 * state where that still makes sense, and derived where it does not.
 */
export interface DeviceRequest {
	deviceSize: DeviceSize;
	rotation?: Rotation;
	/** An exact size. Decides the orientation itself. */
	size?: ViewportSize | null;
	/** A model of `deviceSize`; one of another class falls back to the class default. */
	deviceModel?: string | null;
}

/**
 * Where a device change lands.
 *
 * The one rule for every way a device gets picked — a class, a model, a typed
 * or dragged size, a rotation, an agent's `set_viewport` — shared by the panel
 * and the server so the two cannot disagree:
 *
 * - an exact size wins, and its shape decides the orientation;
 * - a new class or model starts from that model's own size, turned to the
 *   requested orientation (a new class: its natural one);
 * - otherwise the current size is kept, turned to the requested orientation —
 *   so rotating a custom size keeps its dimensions;
 * - responsive has no size of its own and keeps whatever the page had.
 */
export function planDevice(current: DeviceState | null, request: DeviceRequest): DeviceState {
	const deviceSize = request.deviceSize;
	const classChanged = !current || current.deviceSize !== deviceSize;

	const requestedModel =
		request.deviceModel !== undefined ? request.deviceModel : classChanged ? null : current.deviceModel;
	const preset = resolveDevicePreset(deviceSize, requestedModel);
	const deviceModel = preset?.id ?? null;
	const modelChanged = classChanged || deviceModel !== current.deviceModel;

	let rotation: Rotation =
		request.rotation ??
		(!classChanged
			? current.rotation
			: deviceSize === 'responsive' && current
				? orientationOf(current.viewport)
				: defaultRotation(deviceSize));

	// A laptop only lies one way; anything that asked otherwise without an
	// exact size to insist on gets the way it actually lies.
	if (!canRotate(deviceSize) && !request.size) rotation = 'landscape';

	let viewport: ViewportSize;
	if (request.size) {
		viewport = clampViewport(request.size);
		// A square has no orientation of its own, so the requested one stands.
		if (viewport.width !== viewport.height) rotation = orientationOf(viewport);
	} else if (preset && modelChanged) {
		viewport = orient(preset, rotation);
	} else if (current) {
		viewport = orient(current.viewport, rotation);
	} else {
		viewport = getViewportDimensions(deviceSize, rotation);
	}

	return { deviceSize, rotation, viewport, deviceModel };
}

/**
 * The colours a page asks to be framed in, read from the page itself the way
 * a mobile browser reads them — never sampled from pixels.
 */
export interface PageColors {
	/** The status bar: the page's `theme-color` when it has one, else its background. */
	statusBar: string;
	/** Everything else around the page: the root or body background. */
	background: string;
}

// ============================================================================
// Emulation
// ============================================================================

export type ColorSchemeOverride = 'light' | 'dark';
export type ReducedMotionOverride = 'reduce' | 'no-preference';

/**
 * Device settings an agent (or a future control) can set on a tab beyond the
 * model it is shown on. Absent means "what the device would do".
 */
export interface DeviceEmulationOverrides {
	/** Touch input and `'ontouchstart' in window`. Default: on for phones and tablets. */
	touch?: boolean;
	/** Mobile viewport: `<meta viewport>` honoured, overlay scrollbars. Default: on for phones and tablets. */
	mobile?: boolean;
	/** `prefers-color-scheme`. Default: whatever the browser reports. */
	colorScheme?: ColorSchemeOverride;
	/** `prefers-reduced-motion`. Default: whatever the browser reports. */
	reducedMotion?: ReducedMotionOverride;
}

/**
 * How the page should believe it is being viewed.
 *
 * Phones and tablets are emulated as such: `<meta name="viewport">` is honoured,
 * `(hover: none)` and `(pointer: coarse)` match, and `'ontouchstart' in window`
 * is true from the first script. Without it the Mobile class was a desktop
 * page in a narrow window, which is not what a phone shows. Overrides win over
 * the class, so a touch laptop or a desktop-mode phone can be tested too.
 *
 * The scale factor stays at 1 on purpose: the capture is sized from the
 * viewer's own display, not from what the page thinks its density is.
 */
export function getDeviceEmulation(
	deviceSize: DeviceSize,
	overrides?: DeviceEmulationOverrides | null
): { isMobile: boolean; hasTouch: boolean } {
	const handheld = deviceSize === 'mobile' || deviceSize === 'tablet';
	return {
		isMobile: overrides?.mobile ?? handheld,
		hasTouch: overrides?.touch ?? handheld
	};
}

/**
 * How large the preview is drawn. `fit` scales it to the panel, never past
 * 100%; a number is a fixed zoom and the panel scrolls when it does not fit.
 * Capped at 100% because the capture is never sharper than the page itself.
 */
export type PreviewZoom = 'fit' | number;

export const PREVIEW_ZOOM_LEVELS = [0.25, 0.5, 0.75, 1] as const;

export function isPreviewZoom(value: unknown): value is PreviewZoom {
	return value === 'fit' || (PREVIEW_ZOOM_LEVELS as readonly unknown[]).includes(value);
}

// ============================================================================
// Device frames
// ============================================================================

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

interface Edges {
	top: number;
	right: number;
	bottom: number;
	left: number;
}

/** Corner radii, clockwise from top-left — the order CSS `border-radius` takes. */
export type Corners = [number, number, number, number];

export type FrameKind = 'phone' | 'tablet' | 'laptop' | 'monitor' | 'none';

/** What the body is made of, which decides its colour. */
export type DeviceFinish = 'aluminum' | 'titanium' | 'space-black' | 'plastic';

type ButtonEdge = 'top' | 'right' | 'bottom' | 'left';

export interface FrameButton extends Rect {
	edge: ButtonEdge;
}

/**
 * Where everything in a device mockup sits, in unscaled pixels from the
 * top-left of its footprint.
 *
 * The layers nest from the outside in: the `body`, the black `glass` set into
 * it, the lit `display` behind the glass, and inside the display the `screen`
 * — the page's own viewport — with the system UI (status bar, menu bar,
 * taskbar, home indicator) in the strips around it. The page is never covered
 * by any of that; the strips sit beside it, as they do on the real device.
 *
 * Both the mockup and every overlay drawn over the page read from here, so
 * the two cannot disagree about where the page is.
 */
export interface FrameLayout {
	kind: FrameKind;
	/** The model drawn, or null when there is no mockup. */
	model: string | null;
	os: DeviceOs | null;
	finish: DeviceFinish | null;
	orientation: Rotation;
	/** Everything, accessories included: the box the preview has to fit. */
	footprint: ViewportSize;
	body: Rect;
	bodyRadius: Corners;
	glass: Rect;
	glassRadius: Corners;
	display: Rect;
	displayRadius: Corners;
	/** The page viewport. */
	screen: Rect;
	/** System UI strip above the page: status bar or menu bar. */
	statusBar: Rect | null;
	/** System UI strip below the page: home indicator area, nav bar or taskbar. */
	bottomBar: Rect | null;
	/** iOS / iPadOS home indicator. */
	homeIndicator: Rect | null;
	/**
	 * Android three-button navigation (back, home, recents): a horizontal bar
	 * along the bottom, or a vertical one down the right of a turned phone.
	 */
	navBar: (Rect & { direction: 'horizontal' | 'vertical' }) | null;
	island: Rect | null;
	punchHole: Rect | null;
	notch: Rect | null;
	/** A lens in the bezel — the islands, holes and notches carry their own. */
	camera: { x: number; y: number; size: number } | null;
	earpiece: Rect | null;
	homeButton: Rect | null;
	buttons: FrameButton[];
	/** Laptop deck, seen edge-on below the lid, and what is cut into or under it. */
	base: Rect | null;
	baseStyle: 'macbook' | 'notebook' | null;
	scoop: Rect | null;
	feet: Rect[];
	/** Monitor stand. */
	neck: Rect | null;
	foot: Rect | null;
	standStyle: 'studio' | 'pedestal' | null;
	/**
	 * The page's own corner rounding — whatever of the display's rounding the
	 * system bands do not already absorb. A portrait phone's thin home strip
	 * leaves the page's bottom corners partly under the curve of the glass.
	 */
	screenRadius: Corners;
}

interface ButtonSpec {
	edge: ButtonEdge;
	/** Where along the edge it starts and how long it runs, as fractions of that edge. */
	start: number;
	length: number;
}

/**
 * One device's hardware.
 *
 * Bezels and buttons are drawn for the device held its natural way — portrait
 * for phones and tablets — and turned for the other orientation; the system UI
 * strips are given per orientation, because systems lay them out differently
 * when turned (an iPhone drops its status bar, an Android phone keeps it).
 */
interface DeviceModelSpec {
	kind: Exclude<FrameKind, 'none'>;
	finish: DeviceFinish;
	/** Body edge → glass edge. */
	rim: number;
	/** Black border: glass edge → lit display, in the natural orientation. */
	border: Edges;
	/**
	 * System UI bands per orientation, beside the page and never over it: the
	 * status bar and the camera cutout above or to the side, the home
	 * indicator below, the menu bar or taskbar on a computer. This is where
	 * Safari and Chrome keep a page that has not opted into running under them
	 * (`viewport-fit=auto`), painted in the page's own colours.
	 */
	chrome: Record<Rotation, Edges>;
	bodyRadius: Corners;
	glassRadius: Corners;
	displayRadius: Corners;
	cutout?: { kind: 'island'; long: number; short: number } | { kind: 'punch-hole'; size: number } | { kind: 'notch' };
	/**
	 * A lens in the bezel: centred on the natural top edge, or on the edge that
	 * is on top when the device lies landscape.
	 */
	camera?: 'border-top' | 'border-long';
	earpiece?: boolean;
	homeButton?: boolean;
	buttons?: ButtonSpec[];
	base?: 'macbook' | 'macbook-pro' | 'notebook';
	stand?: 'studio' | 'pedestal';
}

const all = (n: number): Edges => ({ top: n, right: n, bottom: n, left: n });
const corners = (top: number, bottom = top): Corners => [top, top, bottom, bottom];
const edges = (top: number, right: number, bottom: number, left: number): Edges => ({ top, right, bottom, left });

const NO_CHROME = all(0);

/**
 * Proportions after the real hardware, in the same units the page is laid out
 * in — which for an iPhone or an iPad are the points its own UI is drawn in,
 * so a 50pt status bar here is a 50pt status bar there.
 */
const DEVICE_MODELS: Record<string, DeviceModelSpec> = {
	// ── Phones ────────────────────────────────────────────────────────────
	'iphone-16': {
		kind: 'phone',
		finish: 'aluminum',
		rim: 4,
		border: all(9),
		chrome: { portrait: edges(50, 0, 22, 0), landscape: edges(0, 50, 20, 50) },
		bodyRadius: corners(66),
		glassRadius: corners(62),
		displayRadius: corners(53),
		cutout: { kind: 'island', long: 120, short: 35 },
		buttons: [
			{ edge: 'left', start: 0.15, length: 0.036 }, // Action button
			{ edge: 'left', start: 0.22, length: 0.07 }, // Volume up
			{ edge: 'left', start: 0.31, length: 0.07 }, // Volume down
			{ edge: 'right', start: 0.25, length: 0.11 }, // Side button
			{ edge: 'right', start: 0.6, length: 0.065 } // Camera Control
		]
	},
	'iphone-16-pro-max': {
		kind: 'phone',
		finish: 'titanium',
		rim: 3.5,
		border: all(6.5),
		chrome: { portrait: edges(54, 0, 22, 0), landscape: edges(0, 54, 20, 54) },
		bodyRadius: corners(70),
		glassRadius: corners(66.5),
		displayRadius: corners(60),
		cutout: { kind: 'island', long: 126, short: 37 },
		buttons: [
			{ edge: 'left', start: 0.16, length: 0.034 },
			{ edge: 'left', start: 0.225, length: 0.065 },
			{ edge: 'left', start: 0.305, length: 0.065 },
			{ edge: 'right', start: 0.26, length: 0.1 },
			{ edge: 'right', start: 0.62, length: 0.06 }
		]
	},
	'iphone-se': {
		kind: 'phone',
		finish: 'aluminum',
		rim: 4,
		border: edges(100, 20, 100, 20),
		// iOS on a home-button iPhone: a 20pt status bar, hidden in landscape.
		chrome: { portrait: edges(20, 0, 0, 0), landscape: NO_CHROME },
		bodyRadius: corners(58),
		glassRadius: corners(54),
		displayRadius: corners(0),
		camera: 'border-top',
		earpiece: true,
		homeButton: true,
		buttons: [
			{ edge: 'left', start: 0.13, length: 0.03 }, // Ring/Silent switch
			{ edge: 'left', start: 0.2, length: 0.06 },
			{ edge: 'left', start: 0.28, length: 0.06 },
			{ edge: 'right', start: 0.19, length: 0.08 }
		]
	},
	'pixel-9': {
		kind: 'phone',
		finish: 'aluminum',
		rim: 4,
		border: all(11),
		// Three-button navigation: along the bottom when upright, down the right
		// edge when turned — the bottom is then free and the page reaches it.
		// The status bar stays on top, with the camera hole on the left.
		chrome: { portrait: edges(36, 0, 48, 0), landscape: edges(24, 48, 0, 36) },
		bodyRadius: corners(56),
		glassRadius: corners(52),
		displayRadius: corners(42),
		cutout: { kind: 'punch-hole', size: 22 },
		buttons: [
			{ edge: 'right', start: 0.22, length: 0.07 }, // Power
			{ edge: 'right', start: 0.32, length: 0.13 } // Volume rocker
		]
	},
	'galaxy-s24': {
		kind: 'phone',
		finish: 'aluminum',
		rim: 3,
		border: all(7),
		chrome: { portrait: edges(30, 0, 48, 0), landscape: edges(22, 48, 0, 30) },
		bodyRadius: corners(42),
		glassRadius: corners(39),
		displayRadius: corners(33),
		cutout: { kind: 'punch-hole', size: 18 },
		buttons: [
			{ edge: 'right', start: 0.2, length: 0.12 }, // Volume rocker
			{ edge: 'right', start: 0.36, length: 0.065 } // Side key
		]
	},

	// ── Tablets ───────────────────────────────────────────────────────────
	'ipad-pro-11': {
		kind: 'tablet',
		finish: 'aluminum',
		rim: 4,
		border: all(24),
		chrome: { portrait: edges(24, 0, 18, 0), landscape: edges(24, 0, 18, 0) },
		bodyRadius: corners(48),
		glassRadius: corners(44),
		displayRadius: corners(18),
		camera: 'border-long',
		buttons: [
			{ edge: 'top', start: 0.8, length: 0.065 }, // Top button
			{ edge: 'right', start: 0.07, length: 0.045 },
			{ edge: 'right', start: 0.125, length: 0.045 }
		]
	},
	'ipad-pro-13': {
		kind: 'tablet',
		finish: 'aluminum',
		rim: 4,
		border: all(26),
		chrome: { portrait: edges(24, 0, 18, 0), landscape: edges(24, 0, 18, 0) },
		bodyRadius: corners(52),
		glassRadius: corners(48),
		displayRadius: corners(20),
		camera: 'border-long',
		buttons: [
			{ edge: 'top', start: 0.82, length: 0.055 },
			{ edge: 'right', start: 0.06, length: 0.04 },
			{ edge: 'right', start: 0.11, length: 0.04 }
		]
	},
	'ipad-mini': {
		kind: 'tablet',
		finish: 'aluminum',
		rim: 4,
		border: all(30),
		chrome: { portrait: edges(24, 0, 18, 0), landscape: edges(24, 0, 18, 0) },
		bodyRadius: corners(46),
		glassRadius: corners(42),
		displayRadius: corners(21),
		// The mini keeps its camera on the short edge, above the display.
		camera: 'border-top',
		buttons: [
			{ edge: 'top', start: 0.56, length: 0.07 }, // Volume up
			{ edge: 'top', start: 0.645, length: 0.07 }, // Volume down
			{ edge: 'top', start: 0.79, length: 0.1 } // Top button with Touch ID
		]
	},
	'galaxy-tab-s9': {
		kind: 'tablet',
		finish: 'aluminum',
		rim: 3,
		border: all(22),
		// A tablet keeps its navigation buttons along the bottom either way up.
		chrome: { portrait: edges(24, 0, 48, 0), landscape: edges(24, 0, 48, 0) },
		bodyRadius: corners(34),
		glassRadius: corners(31),
		displayRadius: corners(12),
		camera: 'border-long',
		buttons: [
			{ edge: 'right', start: 0.08, length: 0.05 }, // Side key
			{ edge: 'right', start: 0.15, length: 0.08 } // Volume
		]
	},

	// ── Laptops ───────────────────────────────────────────────────────────
	'macbook-air-13': {
		kind: 'laptop',
		finish: 'aluminum',
		rim: 3,
		border: edges(14, 14, 24, 14),
		chrome: { portrait: edges(30, 0, 0, 0), landscape: edges(30, 0, 0, 0) },
		bodyRadius: corners(20, 6),
		glassRadius: corners(17, 4),
		displayRadius: corners(10, 0),
		cutout: { kind: 'notch' },
		base: 'macbook'
	},
	'macbook-pro-16': {
		kind: 'laptop',
		finish: 'space-black',
		rim: 3,
		border: edges(12, 12, 20, 12),
		chrome: { portrait: edges(32, 0, 0, 0), landscape: edges(32, 0, 0, 0) },
		bodyRadius: corners(22, 6),
		glassRadius: corners(19, 4),
		displayRadius: corners(11, 0),
		cutout: { kind: 'notch' },
		base: 'macbook-pro'
	},
	'windows-laptop': {
		kind: 'laptop',
		finish: 'plastic',
		rim: 2,
		border: edges(22, 16, 30, 16),
		// Windows puts its system UI at the bottom: the taskbar.
		chrome: { portrait: edges(0, 0, 40, 0), landscape: edges(0, 0, 40, 0) },
		bodyRadius: corners(10, 4),
		glassRadius: corners(8, 2),
		displayRadius: corners(0),
		camera: 'border-top',
		base: 'notebook'
	},

	// ── Monitors ──────────────────────────────────────────────────────────
	'monitor-fhd': {
		kind: 'monitor',
		finish: 'plastic',
		rim: 2,
		border: edges(8, 8, 30, 8),
		chrome: { portrait: edges(0, 0, 44, 0), landscape: edges(0, 0, 44, 0) },
		bodyRadius: corners(8),
		glassRadius: corners(6),
		displayRadius: corners(0),
		stand: 'pedestal'
	},
	'studio-display': {
		kind: 'monitor',
		finish: 'aluminum',
		rim: 6,
		border: all(26),
		chrome: { portrait: edges(26, 0, 0, 0), landscape: edges(26, 0, 0, 0) },
		bodyRadius: corners(18),
		glassRadius: corners(12),
		displayRadius: corners(3),
		camera: 'border-top',
		stand: 'studio'
	},
	'monitor-hd': {
		kind: 'monitor',
		finish: 'plastic',
		rim: 2,
		border: edges(10, 10, 26, 10),
		chrome: { portrait: edges(0, 0, 40, 0), landscape: edges(0, 0, 40, 0) },
		bodyRadius: corners(8),
		glassRadius: corners(6),
		displayRadius: corners(0),
		stand: 'pedestal'
	}
};

/** Quarter turn counter-clockwise: portrait right edge ends up on top. */
function turnEdges(e: Edges): Edges {
	return { top: e.right, right: e.bottom, bottom: e.left, left: e.top };
}

function turnButton(button: ButtonSpec): ButtonSpec {
	switch (button.edge) {
		case 'right':
			return { edge: 'top', start: button.start, length: button.length };
		case 'top':
			return { edge: 'left', start: 1 - button.start - button.length, length: button.length };
		case 'left':
			return { edge: 'bottom', start: button.start, length: button.length };
		case 'bottom':
			return { edge: 'right', start: 1 - button.start - button.length, length: button.length };
	}
}

const BUTTON_DEPTH = 3;

const clampTo = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function flatLayout(viewport: ViewportSize, orientation: Rotation): FrameLayout {
	const page: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
	const flat: Corners = [0, 0, 0, 0];
	return {
		kind: 'none',
		model: null,
		os: null,
		finish: null,
		orientation,
		footprint: { width: viewport.width, height: viewport.height },
		body: page,
		bodyRadius: flat,
		glass: page,
		glassRadius: flat,
		display: page,
		displayRadius: flat,
		screen: page,
		statusBar: null,
		bottomBar: null,
		homeIndicator: null,
		navBar: null,
		island: null,
		punchHole: null,
		notch: null,
		camera: null,
		earpiece: null,
		homeButton: null,
		buttons: [],
		base: null,
		baseStyle: null,
		scoop: null,
		feet: [],
		neck: null,
		foot: null,
		standStyle: null,
		screenRadius: flat
	};
}

/**
 * Lay out a device mockup around a viewport of the given size.
 *
 * The model decides the hardware; the orientation is read off the viewport's
 * own shape rather than taken as an argument, so the frame cannot be drawn for
 * one orientation around a page laid out in the other. With `showFrame` off,
 * or for `responsive`, there is no mockup: every layer collapses onto the page.
 */
export function getFrameLayout(
	deviceSize: DeviceSize,
	viewport: ViewportSize,
	showFrame = true,
	deviceModel?: string | null
): FrameLayout {
	const orientation = orientationOf(viewport);
	const preset = resolveDevicePreset(deviceSize, deviceModel);
	const spec = preset ? DEVICE_MODELS[preset.id] : undefined;
	if (!preset || !spec || !showFrame) return flatLayout(viewport, orientation);

	const vw = viewport.width;
	const vh = viewport.height;
	const handheld = spec.kind === 'phone' || spec.kind === 'tablet';
	const turned = handheld && orientation === 'landscape';

	const rim = all(spec.rim);
	const border = turned ? turnEdges(spec.border) : spec.border;
	const chrome = spec.chrome[orientation];

	// Sizes first, from the page outwards.
	const displayW = chrome.left + vw + chrome.right;
	const displayH = chrome.top + vh + chrome.bottom;
	const glassW = border.left + displayW + border.right;
	const glassH = border.top + displayH + border.bottom;
	const bodyW = rim.left + glassW + rim.right;
	const bodyH = rim.top + glassH + rim.bottom;

	// Accessories, which decide how far the footprint reaches past the body.
	const buttonSpecs = (spec.buttons ?? []).map((button) => (turned ? turnButton(button) : button));
	const buttonEdges = new Set(buttonSpecs.map((b) => b.edge));

	let baseW = 0;
	let baseH = 0;
	let feetH = 0;
	let neckW = 0;
	let neckH = 0;
	let footW = 0;
	let footH = 0;
	if (spec.base === 'macbook') {
		baseW = Math.round(bodyW * 1.12);
		baseH = Math.round(clampTo(bodyW * 0.012, 12, 22));
	} else if (spec.base === 'macbook-pro') {
		baseW = Math.round(bodyW * 1.1);
		baseH = Math.round(clampTo(bodyW * 0.016, 16, 30));
		feetH = 4;
	} else if (spec.base === 'notebook') {
		baseW = Math.round(bodyW * 1.06);
		baseH = Math.round(clampTo(bodyW * 0.018, 14, 26));
		feetH = 3;
	}
	if (spec.stand === 'studio') {
		neckW = Math.round(clampTo(bodyW * 0.17, 110, 380));
		neckH = Math.round(clampTo(bodyH * 0.14, 60, 180));
		footW = Math.round(neckW * 1.35);
		footH = Math.round(clampTo(bodyW * 0.007, 8, 14));
	} else if (spec.stand === 'pedestal') {
		neckW = Math.round(clampTo(bodyW * 0.045, 36, 90));
		neckH = Math.round(clampTo(bodyH * 0.16, 70, 190));
		footW = Math.round(clampTo(bodyW * 0.34, 220, 700));
		footH = Math.round(clampTo(bodyW * 0.014, 12, 24));
	}

	const sideReach = Math.max(baseW, footW) > bodyW ? (Math.max(baseW, footW) - bodyW) / 2 : 0;
	const outset: Edges = {
		top: buttonEdges.has('top') ? BUTTON_DEPTH : 0,
		right: Math.max(sideReach, buttonEdges.has('right') ? BUTTON_DEPTH : 0),
		bottom: Math.max(baseH + feetH, neckH + footH, buttonEdges.has('bottom') ? BUTTON_DEPTH : 0),
		left: Math.max(sideReach, buttonEdges.has('left') ? BUTTON_DEPTH : 0)
	};

	// Then positions, from the body inwards.
	const body: Rect = { x: outset.left, y: outset.top, width: bodyW, height: bodyH };
	const glass: Rect = { x: body.x + rim.left, y: body.y + rim.top, width: glassW, height: glassH };
	const display: Rect = { x: glass.x + border.left, y: glass.y + border.top, width: displayW, height: displayH };
	const screen: Rect = { x: display.x + chrome.left, y: display.y + chrome.top, width: vw, height: vh };
	const [tl, tr, br, bl] = spec.displayRadius;
	const screenRadius: Corners = [
		Math.max(0, tl - Math.max(chrome.left, chrome.top)),
		Math.max(0, tr - Math.max(chrome.right, chrome.top)),
		Math.max(0, br - Math.max(chrome.right, chrome.bottom)),
		Math.max(0, bl - Math.max(chrome.left, chrome.bottom))
	];

	const statusBar: Rect | null =
		chrome.top > 0 ? { x: display.x, y: display.y, width: displayW, height: chrome.top } : null;
	const bottomBar: Rect | null =
		chrome.bottom > 0
			? { x: display.x, y: display.y + displayH - chrome.bottom, width: displayW, height: chrome.bottom }
			: null;

	// iOS home indicator.
	let homeIndicator: Rect | null = null;
	if (bottomBar && (preset.os === 'ios' || preset.os === 'ipados')) {
		const barW =
			orientation === 'portrait' || spec.kind === 'tablet'
				? clampTo(displayW * (spec.kind === 'tablet' ? 0.24 : 0.34), 100, 300)
				: clampTo(displayW * 0.24, 140, 220);
		homeIndicator = {
			x: display.x + (displayW - barW) / 2,
			y: bottomBar.y + bottomBar.height / 2 - 2.5,
			width: barW,
			height: 5
		};
	}

	// Android navigation buttons: the bottom band, or the right one when a
	// turned phone moved them there.
	let navBar: FrameLayout['navBar'] = null;
	if (preset.os === 'android') {
		if (bottomBar) {
			navBar = { ...bottomBar, direction: 'horizontal' };
		} else if (chrome.right > 0) {
			navBar = {
				x: screen.x + vw,
				y: screen.y,
				width: chrome.right,
				height: vh,
				direction: 'vertical'
			};
		}
	}

	let island: Rect | null = null;
	let punchHole: Rect | null = null;
	let notch: Rect | null = null;
	let camera: FrameLayout['camera'] = null;
	let earpiece: Rect | null = null;
	let homeButton: Rect | null = null;

	const cutout = spec.cutout;
	if (cutout?.kind === 'island') {
		island =
			orientation === 'portrait'
				? { x: display.x + (displayW - cutout.long) / 2, y: display.y + 11, width: cutout.long, height: cutout.short }
				: { x: display.x + 11, y: display.y + (displayH - cutout.long) / 2, width: cutout.short, height: cutout.long };
		camera = {
			x: orientation === 'portrait' ? island.x + island.width - cutout.short / 2 : island.x + cutout.short / 2,
			y: orientation === 'portrait' ? island.y + cutout.short / 2 : island.y + island.height - cutout.short / 2,
			size: Math.round(cutout.short * 0.32)
		};
	} else if (cutout?.kind === 'punch-hole') {
		const size = cutout.size;
		punchHole =
			orientation === 'portrait'
				? { x: display.x + (displayW - size) / 2, y: display.y + (chrome.top - size) / 2, width: size, height: size }
				: { x: display.x + (chrome.left - size) / 2, y: display.y + (displayH - size) / 2, width: size, height: size };
	} else if (cutout?.kind === 'notch') {
		const notchW = Math.round(clampTo(displayW * 0.13, 120, 240));
		notch = { x: display.x + (displayW - notchW) / 2, y: display.y, width: notchW, height: chrome.top };
		camera = { x: notch.x + notchW / 2, y: notch.y + chrome.top / 2, size: 9 };
	}

	// The natural top edge: on top for a laptop, a monitor or an upright
	// handheld; on the left for a handheld turned counter-clockwise.
	const naturalTopCentre = turned
		? { x: glass.x + border.left / 2, y: glass.y + glassH / 2 }
		: { x: glass.x + glassW / 2, y: glass.y + border.top / 2 };
	const naturalBottomCentre = turned
		? { x: glass.x + glassW - border.right / 2, y: glass.y + glassH / 2 }
		: { x: glass.x + glassW / 2, y: glass.y + glassH - border.bottom / 2 };

	if (spec.camera === 'border-top') {
		const size = spec.kind === 'phone' ? 10 : 8;
		camera = spec.earpiece
			? // Beside the earpiece, not on it.
				turned
				? { x: naturalTopCentre.x, y: naturalTopCentre.y + 46, size }
				: { x: naturalTopCentre.x - 46, y: naturalTopCentre.y, size }
			: { ...naturalTopCentre, size };
	} else if (spec.camera === 'border-long') {
		// The edge that is on top in landscape — on the right when upright.
		camera =
			orientation === 'landscape'
				? { x: glass.x + glassW / 2, y: glass.y + border.top / 2, size: 9 }
				: { x: glass.x + glassW - border.right / 2, y: glass.y + glassH / 2, size: 9 };
	}

	if (spec.earpiece) {
		const long = 58;
		const short = 6;
		earpiece = turned
			? { x: naturalTopCentre.x - short / 2, y: naturalTopCentre.y - long / 2, width: short, height: long }
			: { x: naturalTopCentre.x - long / 2, y: naturalTopCentre.y - short / 2, width: long, height: short };
	}

	if (spec.homeButton) {
		const size = Math.round(clampTo((turned ? border.right : border.bottom) * 0.64, 40, 72));
		homeButton = { x: naturalBottomCentre.x - size / 2, y: naturalBottomCentre.y - size / 2, width: size, height: size };
	}

	const buttons: FrameButton[] = buttonSpecs.map((button) => {
		const horizontal = button.edge === 'top' || button.edge === 'bottom';
		const along = horizontal ? bodyW : bodyH;
		const start = (horizontal ? body.x : body.y) + along * button.start;
		const length = along * button.length;
		switch (button.edge) {
			case 'top':
				return { edge: 'top', x: start, y: body.y - BUTTON_DEPTH, width: length, height: BUTTON_DEPTH + 1 };
			case 'bottom':
				return { edge: 'bottom', x: start, y: body.y + bodyH - 1, width: length, height: BUTTON_DEPTH + 1 };
			case 'left':
				return { edge: 'left', x: body.x - BUTTON_DEPTH, y: start, width: BUTTON_DEPTH + 1, height: length };
			case 'right':
				return { edge: 'right', x: body.x + bodyW - 1, y: start, width: BUTTON_DEPTH + 1, height: length };
		}
	});

	const centreX = body.x + bodyW / 2;
	const base: Rect | null =
		baseW > 0 ? { x: centreX - baseW / 2, y: body.y + bodyH, width: baseW, height: baseH } : null;
	const scoop: Rect | null =
		base && spec.base !== 'notebook'
			? { x: centreX - bodyW * 0.08, y: base.y, width: bodyW * 0.16, height: Math.max(4, baseH * 0.3) }
			: null;
	const feet: Rect[] =
		base && feetH > 0
			? [0.08, 0.92].map((at) => ({
					x: base.x + base.width * at - base.width * 0.04,
					y: base.y + base.height,
					width: base.width * 0.08,
					height: feetH
				}))
			: [];
	const neck: Rect | null =
		neckW > 0 ? { x: centreX - neckW / 2, y: body.y + bodyH, width: neckW, height: neckH } : null;
	const foot: Rect | null =
		footW > 0 ? { x: centreX - footW / 2, y: body.y + bodyH + neckH, width: footW, height: footH } : null;

	return {
		kind: spec.kind,
		model: preset.id,
		os: preset.os,
		finish: spec.finish,
		orientation,
		footprint: {
			width: outset.left + bodyW + outset.right,
			height: outset.top + bodyH + outset.bottom
		},
		body,
		bodyRadius: spec.bodyRadius,
		glass,
		glassRadius: spec.glassRadius,
		display,
		displayRadius: spec.displayRadius,
		screen,
		statusBar,
		bottomBar,
		homeIndicator,
		navBar,
		island,
		punchHole,
		notch,
		camera,
		earpiece,
		homeButton,
		buttons,
		base,
		baseStyle: spec.base === 'notebook' ? 'notebook' : spec.base ? 'macbook' : null,
		scoop,
		feet,
		neck,
		foot,
		standStyle: spec.stand ?? null,
		screenRadius
	};
}

/** `border-radius` for a set of corners, optionally scaled. */
export function cornersToCss(radius: Corners, scale = 1): string {
	return radius.map((r) => `${r * scale}px`).join(' ');
}
