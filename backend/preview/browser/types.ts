import type { Browser, BrowserContext, Page } from 'puppeteer';
import type { DeviceSize, Rotation } from '$shared/constants/preview.js';

// Re-export types from preview config
export type { DeviceSize, Rotation };

export interface BrowserConsoleMessage {
	id: string;
	type: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace' | 'clear';
	text: string;
	args?: unknown[];
	location?: {
		url: string;
		lineNumber: number;
		columnNumber: number;
	};
	stackTrace?: string;
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
	lastNavigationTime?: number;
	currentUrl?: string;

	// Streaming internals
	lastFrameHash?: string;
	duplicateFrameCount?: number;
	lastUniqueFrameTime?: number;
	stableFrameStartTime?: number;
	lastCursorInfo?: { x: number; y: number; cursor: string };
	scale?: number; // Frontend display fit-scale (CSS-only; does NOT affect capture resolution)

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

export interface BrowserTabInfo {
	id: string;
	url: string;
	title: string;
	quality: 'perfect' | 'good';
	isStreaming: boolean;
	deviceSize: DeviceSize;
	rotation: Rotation;
	isActive: boolean;
}

export interface BrowserAutonomousAction {
	/**
	 * Action types (minimal, native-only, no DOM):
	 * - 'click': Mouse click at coordinates (x, y)
	 * - 'type': Keyboard input - type text OR press single key
	 * - 'move': Move mouse to coordinates (x, y)
	 * - 'scroll': Scroll by delta amount, optionally at target area (x, y)
	 * - 'wait': Wait for specified delay
	 * - 'extract_data': Extract data from DOM element using CSS selector
	 *
	 * All interactions use native browser input (no DOM manipulation except extract_data)
	 */
	type: 'click' | 'type' | 'move' | 'scroll' | 'wait' | 'extract_data';

	// Coordinates for click/move, or target area for scroll
	x?: number;
	y?: number;

	// For scroll action - scroll delta amounts
	deltaX?: number;
	deltaY?: number;

	// For click action
	click?: 'left' | 'right' | 'middle'; // Mouse button (default: 'left')

	// For type action - either text OR key, not both
	text?: string; // Type a string of text
	key?: string; // Press a single key (Enter, Tab, Escape, ArrowUp, etc.)
	clearFirst?: boolean; // Clear existing input before typing (default: true for MCP, false for user)

	// For extract_data action
	selector?: string; // Element identifier - tool automatically tries all selector patterns and attributes

	// Timing options
	delay?: number;
	steps?: number; // For mouse movement interpolation

	// Behavior options
	humanLike?: boolean; // Simulate human-like movement/typing
	smooth?: boolean; // For smooth scrolling
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
 * Unified Streaming Configuration
 *
 * Central configuration for WebCodecs streaming (video + audio).
 * Used across audio capture, video capture, and session management.
 *
 * Single source of truth for all codec settings.
 */
export interface StreamingConfig {
	video: {
		codec: string; // Fallback codec (VP8, fixed-bitrate mode) when VP9 quantizer mode is unsupported
        width: number;
        height: number;
        framerate: number; // Max encode fps — screencast frames above this rate are dropped at the source
        bitrate: number;
        keyframeInterval: number; // Seconds between periodic keyframes; 0 = on-demand only (start/reconnect/client request)
        screenshotQuality: number;
        hardwareAcceleration: 'no-preference' | 'prefer-hardware' | 'prefer-software';
        latencyMode: 'quality' | 'realtime';
        motionQuantizer: number; // VP9 per-frame quantizer (0-63) while the page is moving — cheap, allowed to be soft
        topOffQuantizer: number; // VP9 quantizer for still-page refresh frames — near-lossless so text stays crisp
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
 * - Fallback: VP8 at a resolution-scaled bitrate (see computeBitrate).
 * - Keyframes on demand only (keyframeInterval 0) — the DataChannel is
 *   reliable, and the client requests a keyframe on decoder errors.
 * - Encode rate capped at `framerate` — screencast can fire at compositor
 *   rate (up to 60fps); excess frames are dropped at the source.
 * - JPEG quality 75 for motion source frames (encoder quantizer controls
 *   output size, so higher source quality no longer inflates bandwidth)
 * - Opus for audio (efficient and widely supported)
 */
export const DEFAULT_STREAMING_CONFIG: StreamingConfig = {
	video: {
		codec: 'vp8',
		width: 0,
		height: 0,
		framerate: 24,
		bitrate: 1_000_000,
		keyframeInterval: 0,
		screenshotQuality: 75,
		hardwareAcceleration: 'no-preference',
		latencyMode: 'realtime',
		motionQuantizer: 40,
		topOffQuantizer: 10
	},
	audio: {
		codec: 'opus',
		sampleRate: 48_000,
		bitrate: 128_000,
		numberOfChannels: 2,
		bufferSize: 4096
	}
};

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

export interface BrowserContextMenuInfo {
	tabId: string;
	menuId: string;
	x: number; // Click coordinates
	y: number;
	items: BrowserContextMenuItem[];
	elementInfo: {
		tagName: string;
		isLink: boolean;
		isImage: boolean;
		isInput: boolean;
		isTextSelected: boolean;
		linkUrl?: string;
		imageUrl?: string;
		inputType?: string;
	};
	timestamp: number;
}

export interface BrowserContextMenuResponse {
	tabId: string;
	menuId: string;
	itemId: string; // Selected menu item ID
}

