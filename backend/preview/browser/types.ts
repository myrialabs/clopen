import type { Browser, BrowserContext, Page } from 'puppeteer';
import type { DeviceSize, Rotation } from '$shared/constants/preview.js';

// Re-export types from preview config
export type { DeviceSize, Rotation };

/**
 * A console argument rendered for display.
 *
 * `jsonValue()` cannot represent most of what a page logs — DOM nodes, class
 * instances, functions and anything circular all throw — so values are
 * flattened in the page to a shape the console panel can render and expand
 * without holding a live handle to the object.
 */
export interface BrowserConsoleValue {
	type:
		| 'string'
		| 'number'
		| 'boolean'
		| 'null'
		| 'undefined'
		| 'bigint'
		| 'symbol'
		| 'function'
		| 'array'
		| 'object'
		| 'error'
		| 'node'
		| 'date'
		| 'regexp'
		| 'map'
		| 'set';
	/** Single-line rendering, e.g. `Array(3)` or `<div class="row">`. */
	preview: string;
	/** Expandable children, present for arrays/objects/maps/sets. */
	entries?: Array<{ key: string; value: BrowserConsoleValue }>;
	/** True when `entries` was cut short by the size cap. */
	truncated?: boolean;
}

export interface BrowserConsoleMessage {
	id: string;
	type: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'clear' | 'input' | 'result';
	text: string;
	args?: unknown[];
	/** Structured rendering of `args`, used by the console panel. */
	values?: BrowserConsoleValue[];
	location?: {
		url: string;
		lineNumber: number;
		columnNumber: number;
	};
	stackTrace?: string;
	/** Network status for messages raised from a failed response. */
	status?: number;
	/** Repeat counter for identical consecutive messages, as in DevTools. */
	count?: number;
	timestamp: number;
}

/**
 * Browser Tab Interface
 *
 * Tab-centric architecture where each tab represents a complete browser instance
 * (context + page) from the browser pool. No separate "session" concept.
 */
export interface BrowserTab {
	// Identity
	id: string;
	url: string;
	title: string;
	favicon?: string;
	isActive: boolean;

	// Browser instances (from pool)
	browser: Browser; // Shared browser reference
	context: BrowserContext; // Isolated context (cookies, localStorage, etc.)
	page: Page;

	// Streaming
	isStreaming: boolean;
	quality: 'perfect' | 'good';
	screenshotInterval?: NodeJS.Timeout;
	streamingInterval?: NodeJS.Timeout;
	isCapturing?: boolean;

	// Device
	deviceSize: DeviceSize;
	rotation: Rotation;

	// Console
	consoleLogs: BrowserConsoleMessage[];
	consoleEnabled: boolean;

	// Navigation
	isLoading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	/**
	 * CDP history index the tab started at, captured after its first real
	 * navigation. Back is only offered beyond this point so a fresh tab behaves
	 * like a real browser — you cannot walk back into its initial about:blank.
	 */
	historyBaseIndex?: number;
	lastNavigationTime?: number;
	currentUrl?: string;

	// Streaming internals
	lastFrameHash?: string;
	duplicateFrameCount?: number;
	lastUniqueFrameTime?: number;
	stableFrameStartTime?: number;
	lastCursorInfo?: { x: number; y: number; cursor: string };
	scale?: number; // Frontend display fit-scale — with the viewer's devicePixelRatio, this sets capture resolution

	// Interaction tracking
	lastInteractionTime?: number;
	lastInteractionLogTime?: number;

	// Timestamps
	createdAt: number;
	lastAccessedAt: number;

	// Internal
	isDestroyed?: boolean;
}

/**
 * Tab Events
 */
export interface TabCreatedEvent {
	tabId: string;
	url: string;
	title: string;
	isActive: boolean;
	timestamp: number;
}

export interface TabClosedEvent {
	tabId: string;
	newActiveTabId?: string;
	timestamp: number;
}

export interface TabSwitchedEvent {
	previousTabId: string;
	newTabId: string;
	timestamp: number;
}

export interface TabNavigatedEvent {
	tabId: string;
	url: string;
	title: string;
	timestamp: number;
}

/**
 * Live tab metadata pushed after every navigation.
 *
 * Bundles the three things the toolbar needs and cannot derive from the URL:
 * the page's own title, its favicon, and whether Back/Forward are available.
 */
export interface BrowserTabMeta {
	tabId: string;
	url: string;
	title: string;
	favicon?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	timestamp: number;
}

/** A single entry in a tab's CDP navigation history. */
export interface BrowserHistoryEntry {
	id: number;
	url: string;
	title: string;
}

export interface BrowserHistoryState {
	entries: BrowserHistoryEntry[];
	currentIndex: number;
	canGoBack: boolean;
	canGoForward: boolean;
}

export interface BrowserTabInfo {
	id: string;
	url: string;
	title: string;
	/**
	 * Carried through recovery so a page refresh restores the tab strip as it
	 * looked, instead of falling back to the placeholder until the next reload.
	 */
	favicon?: string;
	quality: 'perfect' | 'good';
	isStreaming: boolean;
	deviceSize: DeviceSize;
	rotation: Rotation;
	isActive: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
}

/** A point in page (emulated viewport) coordinates. */
export interface BrowserPoint {
	x: number;
	y: number;
}

/**
 * Where an action should land. Either explicit page coordinates or an element
 * to resolve — resolution scrolls the element into view and aims at its centre,
 * so the agent never has to guess a pixel it cannot see.
 */
export interface BrowserActionTarget {
	x?: number;
	y?: number;
	/** CSS selector, resolved across every frame including iframes. */
	selector?: string;
	/** Visible text to match when no selector is given. */
	text?: string;
	/** Nth match when the query is ambiguous (0-based, default 0). */
	nth?: number;
}

export type BrowserAutonomousActionType =
	| 'click'
	| 'type'
	| 'move'
	| 'scroll'
	| 'wait'
	| 'extract_data'
	| 'drag'
	| 'press'
	| 'long_press'
	| 'tap'
	| 'swipe'
	| 'pinch'
	| 'select_option'
	| 'upload'
	| 'paste'
	| 'focus'
	| 'clear';

/**
 * One primitive input gesture, executed against a tab's page.
 *
 * Everything here drives native browser input (CDP mouse / keyboard / touch).
 * The only DOM-level actions are the ones that cannot be expressed as input at
 * all: `extract_data`, `select_option`, `upload` and element resolution.
 */
export interface BrowserAutonomousAction {
	type: BrowserAutonomousActionType;

	// Coordinates for click/move/tap, or target area for scroll
	x?: number;
	y?: number;

	/** Element-or-coordinate target. Takes precedence over bare x/y. */
	target?: BrowserActionTarget;

	// For scroll action - scroll delta amounts
	deltaX?: number;
	deltaY?: number;

	/** Mouse button (default: 'left'). */
	button?: 'left' | 'right' | 'middle';
	/** 1 = single, 2 = double, 3 = triple. */
	clickCount?: number;

	// For type action - either text OR key, not both
	text?: string; // Type a string of text
	key?: string; // Press a single key (Enter, Tab, Escape, ArrowUp, etc.)
	/** Chord for `press`, e.g. "Control+Shift+K". */
	keys?: string;
	clearFirst?: boolean; // Clear existing input before typing (default: true for MCP, false for user)

	// For extract_data action
	selector?: string; // Element identifier - tool automatically tries all selector patterns and attributes
	/** Read a specific attribute instead of auto-detecting one. */
	attribute?: string;
	/** Return every match rather than the first. */
	all?: boolean;

	// Drag / swipe endpoints
	from?: BrowserActionTarget;
	to?: BrowserActionTarget;
	/**
	 * 'pointer' drives mousedown → move → mouseup, which is what JS drag
	 * implementations (sliders, canvases, sortable lists) listen for.
	 * 'native' goes through CDP drag interception, needed for HTML5
	 * `draggable="true"` sources, which ignore plain mouse events.
	 * Omit to pick automatically from the source element.
	 */
	mode?: 'pointer' | 'native';

	// For select_option
	value?: string;
	label?: string;
	index?: number;

	// For upload — absolute paths, resolved and access-checked by the caller
	files?: string[];

	// For pinch
	center?: BrowserPoint;
	scale?: number;

	// Timing options
	delay?: number;
	steps?: number; // For mouse movement interpolation
	/** How long to hold (long_press, drag pause before moving). */
	holdMs?: number;
	/** How long to linger after moving (hover dwell, tooltip reveal). */
	dwellMs?: number;
	/** Gesture duration for swipe/pinch. */
	durationMs?: number;

	// Behavior options
	humanLike?: boolean; // Simulate human-like movement/typing
	smooth?: boolean; // For smooth scrolling
	/** Skip scrolling a resolved element into view before acting on it. */
	noScroll?: boolean;
}

/**
 * Per-action outcome, returned in order so a batch can be reported honestly —
 * including which actions never ran.
 */
export interface BrowserActionResult {
	action: BrowserAutonomousActionType;
	ok: boolean;
	/** Human-readable one-liner, e.g. `click (640, 300)`. */
	detail?: string;
	error?: string;
	/** Payload for actions that read something back. */
	data?: unknown;
	selector?: string;
	attribute?: string;
	timestamp: number;
}

export interface BrowserNavigationEvent {
	tabId: string;
	type: 'navigation';
	url: string;
	timestamp: number;
}

export interface BrowserNavigationLoadingEvent {
	tabId: string;
	type: 'navigation-loading';
	url: string;
	timestamp: number;
}

export interface BrowserCursorPosition {
	tabId: string;
	x: number;
	y: number;
	timestamp: number;
}

export interface BrowserConsoleEvent {
	tabId: string;
	message: BrowserConsoleMessage;
}

export interface BrowserScreenshotFrame {
	tabId: string;
	frame: number;
	timestamp: number;
	data: string;
	cursorInfo: any;
	duplicatesSkipped: number;
}

/**
 * Wire codec identifiers.
 *
 * Every video packet carries one of these so the viewer can configure the
 * matching decoder without a side-channel. Values are part of the wire format —
 * append only, never renumber.
 */
export const VIDEO_CODEC_ID = {
	vp8: 0,
	vp9: 1,
	avc: 2
} as const;

export type VideoCodecName = keyof typeof VIDEO_CODEC_ID;

/**
 * A candidate the in-page encoder may use, in preference order.
 *
 * `quantizerKey` selects per-frame quality control (Chrome-Remote-Desktop
 * style): cheap frames during motion, near-lossless when the page goes still.
 * Candidates without it fall back to fixed-bitrate mode, where the still-page
 * refresh is a forced keyframe at a temporarily raised bitrate instead.
 */
export interface VideoCodecCandidate {
	/** WebCodecs codec string, identical on encoder and decoder. */
	codec: string;
	name: VideoCodecName;
	id: number;
	quantizerKey?: 'vp9';
	/**
	 * H.264 must be emitted as Annex-B: we ship raw chunk bytes with no
	 * `description`, so an AVCC-formatted stream would be undecodable.
	 */
	annexb?: boolean;
}

/**
 * Client decode capabilities, negotiated at stream start.
 *
 * The headless browser can encode far more than a given viewer can decode —
 * an iPhone or a low-end Android has hardware H.264 but only software VP9,
 * which is exactly the case where software decoding wrecks the frame rate.
 */
export interface ClientCodecSupport {
	vp8: boolean;
	vp9: boolean;
	avc: boolean;
	/** Codecs the viewer reports a hardware decoder for. */
	hardware: VideoCodecName[];
}

/**
 * Viewer display metrics — drives capture resolution (see computeCaptureSize).
 */
export interface ClientDisplayMetrics {
	/** CSS fit-scale applied to the preview (0-1). */
	scale?: number;
	/** Viewer screen density. */
	dpr?: number;
}

/**
 * Runtime feedback from the viewer's decoder.
 *
 * Backpressure used to be network-only (`bufferedAmount`). A viewer that
 * cannot decode fast enough shows the same symptom — growing latency and
 * stutter — with an empty network buffer, so the decode queue has to travel
 * back to the source as well.
 */
export interface ClientStreamFeedback {
	decodeQueueSize: number;
	/** Mean decode-to-render latency over the reporting window (ms). */
	decodeLatencyMs: number;
	/** Frames dropped before render, as a fraction of frames received. */
	dropRatio: number;
}

/**
 * Unified Streaming Configuration
 *
 * Central configuration for WebCodecs streaming (video + audio).
 * Used across audio capture, video capture, and session management.
 *
 * Single source of truth for all codec settings.
 */
export interface StreamingConfig {
	video: {
		codec: string; // Fallback codec (VP8, fixed-bitrate mode) when nothing better is negotiated
        width: number;
        height: number;
        framerate: number; // Target encode fps — the screencast is throttled to this at the source
        minFramerate: number; // Floor of the adaptive framerate ladder
        bitrate: number;
        keyframeInterval: number; // Seconds between periodic keyframes; 0 = on-demand only (start/reconnect/client request)
        screenshotQuality: number;
        hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
        latencyMode: 'quality' | 'realtime';
        motionQuantizer: number; // Per-frame quantizer (0-63) while the page is moving — cheap, allowed to be soft
        topOffQuantizer: number; // Quantizer for still-page refresh frames — near-lossless so text stays crisp
        /** Ordered encoder candidates resolved from the viewer's capabilities. */
        codecCandidates: VideoCodecCandidate[];
        /**
         * Attempt in-page capture (getDisplayMedia + MediaStreamTrackProcessor)
         * before falling back to the CDP screencast push path. Removes a JPEG
         * encode/decode round-trip and the base64 CDP hop per frame.
         */
        nativeCapture: boolean;
	};
	audio: {
		codec: string
        sampleRate: number;
        bitrate: number;
        numberOfChannels: number;
        bufferSize: number;
	};
}

/**
 * Default streaming configuration
 *
 * Chrome-Remote-Desktop-style adaptive quality:
 * - Preferred: VP9 in quantizer mode — motion frames encoded cheaply
 *   (motionQuantizer, raised further under congestion), and when the page
 *   goes still a near-lossless refresh frame is sent (topOffQuantizer) so
 *   text stays crisp. Idle pages cost ~0 bandwidth (CDP screencast only
 *   fires on damage).
 * - H.264 when the viewer has a hardware decoder for it but not for VP9
 *   (phones, tablets, low-end laptops) — fixed-bitrate mode with a bitrate
 *   bump on the still-page refresh.
 * - Fallback: VP8 at a resolution-scaled bitrate (see computeBitrate).
 * - Keyframes on demand only (keyframeInterval 0) — the DataChannel is
 *   reliable, and the client requests a keyframe on decoder errors.
 * - Encode rate capped at `framerate`, enforced at the source by withholding
 *   the screencast ack so Chrome never rasters frames we would discard.
 * - Resolution, framerate and quantizers are overridden per session from the
 *   host capture profile and the viewer's display metrics; the values here
 *   are only the shape and the fallback for non-streaming call sites.
 * - Opus for audio (efficient and widely supported)
 */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
	video: {
		codec: 'vp8',
		width: 0,
		height: 0,
		framerate: 24,
		minFramerate: 8,
		bitrate: 1_000_000,
		keyframeInterval: 0,
		screenshotQuality: 75,
		hardwareAcceleration: 'no-preference',
		latencyMode: 'realtime',
		motionQuantizer: 40,
		topOffQuantizer: 10,
		codecCandidates: [],
		nativeCapture: false
	},
	audio: {
		codec: 'opus',
		sampleRate: 48_000,
		bitrate: 96_000,
		numberOfChannels: 2,
		bufferSize: 4096
	}
};

/**
 * Build the ordered encoder candidate list for a viewer.
 *
 * **VP9 wins whenever the viewer can decode it at all**, including in software.
 * Only VP9 supports per-frame quantizer control, and that is what the whole
 * quality model rests on: coarse frames while the page moves, a near-lossless
 * refresh the moment it stops. A fixed-bitrate codec has no equivalent — it has
 * to be run at a bitrate high enough for motion (wasteful) or low enough for
 * bandwidth (blocky), and its still-page refresh is just a keyframe.
 *
 * H.264 is therefore reserved for viewers that cannot decode VP9 at all —
 * typically Safari and iOS, which is also where hardware H.264 is guaranteed.
 * Preferring it merely because the viewer *also* has hardware H.264 trades a
 * working quality model for a decode saving the viewer usually doesn't need;
 * viewers that genuinely can't keep up are handled by the decode-feedback
 * ladder instead, which lowers framerate and resolution without changing codec.
 *
 * VP8 is the universal floor and is always appended last.
 */
export function resolveCodecCandidates(support: ClientCodecSupport): VideoCodecCandidate[] {
	const vp9: VideoCodecCandidate = {
		codec: 'vp09.00.10.08',
		name: 'vp9',
		id: VIDEO_CODEC_ID.vp9,
		quantizerKey: 'vp9'
	};
	// Constrained Baseline @ 5.1 — a level ceiling, not a request, so one
	// string covers every viewport we capture and both ends stay in sync
	// without negotiating dimensions first.
	const avc: VideoCodecCandidate = {
		codec: 'avc1.42E033',
		name: 'avc',
		id: VIDEO_CODEC_ID.avc,
		annexb: true
	};
	const vp8: VideoCodecCandidate = {
		codec: 'vp8',
		name: 'vp8',
		id: VIDEO_CODEC_ID.vp8
	};

	const candidates: VideoCodecCandidate[] = [];

	if (support.vp9) candidates.push(vp9);
	if (support.avc) candidates.push(avc);
	if (support.vp8 !== false) candidates.push(vp8);

	return candidates.length > 0 ? candidates : [vp8];
}

/**
 * Native UI Dialog Types
 * Intercepted from headless browser and re-rendered as native dialogs
 */
export interface BrowserDialogEvent {
	tabId: string;
	dialogId: string;
	type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
	message: string;
	defaultValue?: string; // For prompt dialogs
	timestamp: number;
}

export interface BrowserDialogResponse {
	tabId: string;
	dialogId: string;
	accept: boolean; // true = OK/Yes, false = Cancel/No
	promptText?: string; // For prompt dialogs
}

/**
 * Print Request Event
 * Intercepted from window.print() calls
 */
export interface BrowserPrintEvent {
	tabId: string;
	timestamp: number;
}

/**
 * Select Dropdown Types
 * For rendering native select dropdowns over canvas
 */
export interface BrowserSelectOption {
	index: number;
	value: string;
	text: string;
	selected: boolean;
	disabled?: boolean;
	/** `<optgroup>` label this option belongs to, if any. */
	group?: string;
	groupDisabled?: boolean;
}

/**
 * An input whose picker Chrome draws outside the page.
 *
 * Colour swatches and the date/time family open browser-process popups that the
 * screencast cannot see, so the viewer renders the equivalent native control
 * over the canvas and writes the result back.
 */
export interface BrowserNativePickerInfo {
	tabId: string;
	pickerId: string;
	inputType: 'color' | 'date' | 'datetime-local' | 'month' | 'time' | 'week';
	value: string;
	min?: string;
	max?: string;
	step?: string;
	boundingBox: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	timestamp: number;
}

export interface BrowserSelectInfo {
	tabId: string;
	selectId: string;
	x: number; // Click coordinates
	y: number;
	boundingBox: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	options: BrowserSelectOption[];
	selectedIndex: number;
	timestamp: number;
}

export interface BrowserSelectResponse {
	tabId: string;
	selectId: string;
	selectedIndex: number;
}

/**
 * Context Menu Types
 * For rendering native context menus over canvas
 */
export interface BrowserContextMenuItem {
	id: string;
	label: string;
	enabled: boolean;
	type?: 'normal' | 'separator' | 'submenu';
	icon?: string;
	submenu?: BrowserContextMenuItem[];
}

export interface BrowserContextMenuElementInfo {
	tagName: string;
	isLink: boolean;
	isImage: boolean;
	isInput: boolean;
	/** Inputs plus contenteditable regions — everything the edit commands apply to. */
	isEditable: boolean;
	isTextSelected: boolean;
	/** Truncated selection, used only to label the "Search for…" item. */
	selectedText?: string;
	linkUrl?: string;
	linkText?: string;
	imageUrl?: string;
	mediaUrl?: string;
	mediaType?: string;
	inputType?: string;
	pageUrl?: string;
}

export interface BrowserContextMenuInfo {
	tabId: string;
	menuId: string;
	x: number; // Click coordinates
	y: number;
	items: BrowserContextMenuItem[];
	elementInfo: BrowserContextMenuElementInfo;
	timestamp: number;
}

export interface BrowserContextMenuResponse {
	tabId: string;
	menuId: string;
	itemId: string; // Selected menu item ID
}

