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
		| 'mousemove'
		| 'scroll'
		| 'type'
		| 'key'
		| 'checkselectoptions'
		| 'scale-update'
		| 'viewport-update';
	x?: number;
	y?: number;
	deltaX?: number;
	deltaY?: number;
	text?: string;
	key?: string;
	delay?: number;
	steps?: number;
	scale?: number;
	dpr?: number;
	width?: number;
	height?: number;
	deviceSize?: string;
	rotation?: string;
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
 * Send interaction to active tab
 */
export function sendInteraction(action: InteractionAction): void {
	try {
		// Include projectId for project isolation
		ws.emit('preview:browser-interact', { action });
	} catch (error) {
		debug.error('preview', 'Error sending interaction:', error);
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
 * Report display metrics without disturbing the stream.
 *
 * A resize only needs the capture resolution recomputed; `sendScaleUpdate`
 * additionally restarts capture, which is right for recovery but wasteful on
 * every drag frame of a panel resize.
 */
export function sendDisplayUpdate(scale: number): void {
	setDisplayScale(scale);
	ws.http('preview:browser-stream-display', {
		scale,
		dpr: currentDpr()
	}).catch(() => {
		// Best-effort: the next scale-update or reconnect carries it anyway
	});
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
