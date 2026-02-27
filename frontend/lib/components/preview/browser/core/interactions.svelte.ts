/**
 * Browser Interactions
 *
 * Utilities for sending user interactions to browser via WebSocket.
 * All interactions work with active tab on backend.
 */

import ws from '$frontend/lib/utils/ws';
import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/lib/constants/preview';

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
	width?: number;
	height?: number;
	deviceSize?: string;
	rotation?: string;
}

// Store current projectId for interactions
let currentProjectId = '';

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
 * Send scale update to active tab
 */
export function sendScaleUpdate(scale: number): void {
	try {
		ws.emit('preview:browser-interact', {
			action: {
				type: 'scale-update',
				scale
			}
		});
		debug.log('preview', `📐 Sent scale update: ${scale}`);
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
	const { getViewportDimensions } = await import('$frontend/lib/constants/preview.js');

	// Use getViewportDimensions for consistent viewport calculation
	const { width, height } = getViewportDimensions(deviceSize, rotation);

	try {
		ws.emit('preview:browser-interact', {
			action: {
				type: 'viewport-update',
				width,
				height,
				scale,
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
