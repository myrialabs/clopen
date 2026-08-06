/**
 * Frontend Native UI Types
 *
 * Everything the headless browser hands back for the viewer to render itself:
 * dialogs, select dropdowns, context menus, console output, and the capability
 * requests the preview cannot answer without the viewer's own browser.
 */

// Dialog types
export interface BrowserDialogEvent {
	sessionId: string;
	dialogId: string;
	type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
	message: string;
	defaultValue?: string;
	timestamp: number;
}

export interface BrowserPrintEvent {
	sessionId: string;
	timestamp: number;
}

// Select dropdown types
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

export interface BrowserSelectInfo {
	sessionId: string;
	selectId: string;
	x: number;
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

// Context menu types
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
	/** Inputs plus contenteditable regions. */
	isEditable: boolean;
	isTextSelected: boolean;
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
	sessionId: string;
	menuId: string;
	x: number;
	y: number;
	items: BrowserContextMenuItem[];
	elementInfo: BrowserContextMenuElementInfo;
	timestamp: number;
}

/**
 * An input whose picker Chrome renders outside the page.
 *
 * Colour swatches and the date/time family open browser-process popups that the
 * screencast cannot see, so the viewer renders the equivalent control instead.
 */
export interface BrowserNativePickerInfo {
	sessionId: string;
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

/**
 * A console argument, flattened in the page so it can be rendered and expanded
 * without holding a live reference to the original object.
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
	preview: string;
	entries?: Array<{ key: string; value: BrowserConsoleValue }>;
	truncated?: boolean;
}

export type BrowserConsoleType =
	| 'log'
	| 'info'
	| 'warn'
	| 'error'
	| 'debug'
	| 'trace'
	| 'clear'
	| 'input'
	| 'result';

export interface BrowserConsoleMessage {
	id: string;
	type: BrowserConsoleType;
	text: string;
	values?: BrowserConsoleValue[];
	location?: {
		url: string;
		lineNumber: number;
		columnNumber: number;
	};
	stackTrace?: string;
	status?: number;
	/** Repeat counter for identical consecutive messages. */
	count?: number;
	timestamp: number;
}

/** Live tab metadata pushed after every navigation. */
export interface BrowserTabMetaEvent {
	projectId: string;
	tabId: string;
	url: string;
	title: string;
	favicon?: string;
	canGoBack: boolean;
	canGoForward: boolean;
	timestamp: number;
}

/**
 * Capabilities the headless browser routes to the viewer's own browser.
 * Each one maps to a real Web API call made on the viewer's device.
 */
export type HostRequestKind =
	| 'geolocation'
	| 'media-request'
	| 'media-stop'
	| 'media-devices'
	| 'clipboard-read'
	| 'clipboard-write'
	| 'notification-permission'
	| 'notification-show'
	| 'speech-start'
	| 'speech-stop'
	| 'file-pick';

export interface BrowserHostRequestEvent {
	tabId: string;
	requestId: string;
	kind: HostRequestKind;
	payload: any;
	timestamp: number;
}

export interface BrowserDownloadEvent {
	tabId: string;
	downloadId: string;
	filename: string;
	url: string;
	state: 'started' | 'completed' | 'failed';
	data?: string;
	totalBytes?: number;
	error?: string;
	timestamp: number;
}

/**
 * A capability request waiting on the user's decision.
 *
 * Kept separate from the raw event because the prompt outlives it, and because
 * `Allow` has to run the real Web API call from inside the click handler —
 * Safari only grants camera and microphone access to a user gesture.
 */
export interface PendingPermission {
	requestId: string;
	tabId: string;
	kind: HostRequestKind;
	payload: any;
	origin: string;
}
