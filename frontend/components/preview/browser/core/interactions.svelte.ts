/**
 * Browser Interactions
 *
 * Utilities for sending user interactions to browser via WebSocket.
 * All interactions work with active tab on backend.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';

export interface InteractionAction {
	type:
		| 'click'
		| 'doubleclick'
		| 'rightclick'
		| 'mousedown'
		| 'mouseup'
		| 'mousemove'
		| 'scroll'
		| 'stop'
		| 'paste'
		| 'type'
		| 'key'
		| 'keynav'
		| 'checkselectoptions'
		| 'scale-update'
		| 'viewport-update';
	x?: number;
	y?: number;
	deltaX?: number;
	deltaY?: number;
	button?: 'left' | 'right';
	text?: string;
	key?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	delay?: number;
	steps?: number;
	scale?: number;
	dpr?: number;
	width?: number;
	height?: number;
	deviceSize?: string;
	rotation?: string;
}

/**
 * Whether a point in the page accepts text, and what kind of text.
 *
 * Drives the on-screen keyboard on touch devices: the viewer asks about the
 * point under the finger as the tap begins, then raises the keyboard inside the
 * `touchend` handler — the only moment iOS will honour a programmatic focus.
 */
export interface RemoteFocusState {
	editable: boolean;
	inputType?: string;
}

// Store current projectId for interactions
let currentProjectId = '';

/**
 * Last known CSS fit-scale of the preview.
 *
 * Capture resolution is derived from `scale × devicePixelRatio`, so the
 * streaming service needs this value at handshake time — before any resize
 * event would have carried it. Kept here because this module is already the
 * single place that reports scale changes to the backend.
 */
let currentDisplayScale = 1;

export function setDisplayScale(scale: number): void {
	if (scale > 0 && scale <= 1) {
		currentDisplayScale = scale;
	}
}

export function getDisplayScale(): number {
	return currentDisplayScale;
}

function currentDpr(): number {
	return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

/**
 * Set current project ID for interactions
 * Must be called when project changes
 */
export function setInteractionProjectId(projectId: string): void {
	currentProjectId = projectId;
	debug.log('preview', `🔧 Interaction projectId set to: ${projectId}`);
}

/**
 * The backend tab this viewer is looking at.
 *
 * Sent with every interaction. Without it the backend applied input to the
 * project's "active tab" — one value shared by everyone in the project — so
 * with two people watching, one switching tabs silently redirected the other's
 * clicks onto the tab they had just moved to.
 */
let currentTabId: string | null = null;

export function setInteractionTabId(tabId: string | null): void {
	currentTabId = tabId;
}

/**
 * Send interaction to the tab this viewer is watching
 */
export function sendInteraction(action: InteractionAction): void {
	try {
		// Include projectId for project isolation
		ws.emit('preview:browser-interact', { action, tabId: currentTabId ?? undefined });
	} catch (error) {
		debug.error('preview', 'Error sending interaction:', error);
	}
}

/**
 * Read the preview's current text selection, optionally cutting it.
 *
 * Used by the Ctrl+C / Ctrl+X bridge: the keystroke cannot simply be forwarded,
 * because it would land on the headless browser's own clipboard rather than the
 * user's.
 */
export async function readPageSelection(cut = false): Promise<string> {
	try {
		const result = await ws.http(
			'preview:browser-selection',
			{ cut, tabId: currentTabId ?? undefined },
			5000
		);
		return result.text;
	} catch {
		return '';
	}
}

/**
 * Ask the page what sits at a point, before anything is dispatched there.
 *
 * The keyboard decision cannot be made from focus state, which only settles
 * once the tap has been handled — so it always described the *previous* tap.
 * The element under the finger is knowable at `touchstart`, which is early
 * enough to have the answer in hand by `touchend`.
 *
 * Best-effort: a failure (mid-navigation, tab gone) reads as "not editable" so
 * the viewer leaves the keyboard alone rather than raising it over nothing.
 */
export async function probeHitTest(x: number, y: number): Promise<RemoteFocusState> {
	try {
		return await ws.http('preview:browser-hit-test', { x, y, tabId: currentTabId ?? undefined }, 3000);
	} catch {
		return { editable: false };
	}
}

/**
 * Walk the active tab's history.
 */
export async function goHistory(direction: 'back' | 'forward', tabId?: string): Promise<boolean> {
	try {
		const result = await ws.http('preview:browser-tab-history-go', { direction, tabId }, 15000);
		return result.moved;
	} catch (error) {
		debug.error('preview', `Error navigating ${direction}:`, error);
		return false;
	}
}

/**
 * Send scale update to active tab.
 *
 * Doubles as the stream-recovery path (the frontend re-sends the current scale
 * when it detects a stuck stream), so it carries the display metrics too —
 * capture resolution is derived from `scale × devicePixelRatio`.
 */
export function sendScaleUpdate(scale: number): void {
	setDisplayScale(scale);
	try {
		ws.emit('preview:browser-interact', {
			tabId: currentTabId ?? undefined,
			action: {
				type: 'scale-update',
				scale,
				dpr: currentDpr()
			}
		});
		debug.log('preview', `📐 Sent scale update: ${scale} @${currentDpr()}x`);
	} catch (error) {
		debug.error('preview', 'Error sending scale update:', error);
	}
}

/**
 * Send viewport update to active tab
 */
export async function updateViewport(
	deviceSize: DeviceSize,
	rotation: Rotation,
	scale: number
): Promise<void> {
	// Import here to avoid circular dependency
	const { getViewportDimensions } = await import('$frontend/utils/preview-constants.js');

	// Use getViewportDimensions for consistent viewport calculation
	const { width, height } = getViewportDimensions(deviceSize, rotation);

	setDisplayScale(scale);

	try {
		ws.emit('preview:browser-interact', {
			tabId: currentTabId ?? undefined,
			action: {
				type: 'viewport-update',
				width,
				height,
				scale,
				dpr: currentDpr(),
				deviceSize,
				rotation
			}
		});

		debug.log(
			'preview',
			`📱 Sent viewport update: ${width}x${height} (${deviceSize}/${rotation}, scale: ${scale})`
		);
	} catch (error) {
		debug.error('preview', 'Error sending viewport update:', error);
	}
}
