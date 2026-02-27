/**
 * Frontend Native UI Types
 * For dialog, select dropdown, and context menu overlays
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

export interface BrowserContextMenuInfo {
	sessionId: string;
	menuId: string;
	x: number;
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
