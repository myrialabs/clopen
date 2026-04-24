// Preview Configuration
// Centralized configuration for preview components

/**
 * Device viewport dimensions
 * These are the physical pixel dimensions for each device type.
 * Desktop and laptop are naturally landscape (width > height).
 * Tablet and mobile are naturally portrait (height > width).
 */
export const DEVICE_VIEWPORTS = {
	desktop: { width: 1920, height: 1080 },  // FHD — still the most common desktop monitor
	laptop: { width: 1440, height: 900 },    // Modern 14" MacBook Air / 16:10 laptop
	tablet: { width: 834, height: 1194 },    // iPad Pro 11" M4 class
	mobile: { width: 402, height: 874 }      // iPhone 16 / modern flagship phone
} as const;

// Type exports
export type DeviceSize = keyof typeof DEVICE_VIEWPORTS;
export type Rotation = 'portrait' | 'landscape';

/**
 * Get viewport dimensions based on device size and rotation
 *
 * SIMPLE RULE:
 * - Portrait: height > width (vertical orientation)
 * - Landscape: width > height (horizontal orientation)
 */
export function getViewportDimensions(
	deviceSize: DeviceSize,
	rotation: Rotation
): { width: number; height: number } {
	const viewport = DEVICE_VIEWPORTS[deviceSize];

	// Get the larger and smaller dimension
	const larger = Math.max(viewport.width, viewport.height);
	const smaller = Math.min(viewport.width, viewport.height);

	if (rotation === 'portrait') {
		// Portrait: height > width (vertical)
		return { width: smaller, height: larger };
	} else {
		// Landscape: width > height (horizontal)
		return { width: larger, height: smaller };
	}
}

/**
 * Device frame bezel metrics (unscaled pixels).
 *
 * These describe the decorative frame drawn around the canvas for each device
 * type and rotation. The canvas renders at native viewport dimensions; the
 * frame wraps it and the whole device (canvas + frame) is scaled together.
 */
export interface DeviceFrameMetrics {
	top: number;
	right: number;
	bottom: number;
	left: number;
	bodyRadius: number;
	screenRadius: number;
	statusBarHeight: number;
	notch?: 'top' | 'left';
	homeBar?: 'bottom' | 'right';
	cameraDot?: 'top' | 'left';
	stand?: boolean;
}

const FRAME_METRICS: Record<DeviceSize, Record<Rotation, DeviceFrameMetrics>> = {
	desktop: {
		landscape: { top: 14, right: 14, bottom: 20, left: 14, bodyRadius: 14, screenRadius: 6, statusBarHeight: 22, stand: true },
		portrait: { top: 14, right: 14, bottom: 20, left: 14, bodyRadius: 14, screenRadius: 6, statusBarHeight: 22, stand: true }
	},
	laptop: {
		landscape: { top: 14, right: 14, bottom: 22, left: 14, bodyRadius: 14, screenRadius: 6, statusBarHeight: 22 },
		portrait: { top: 14, right: 14, bottom: 22, left: 14, bodyRadius: 14, screenRadius: 6, statusBarHeight: 22 }
	},
	tablet: {
		portrait: { top: 22, right: 26, bottom: 26, left: 26, bodyRadius: 36, screenRadius: 16, statusBarHeight: 26, cameraDot: 'top' },
		landscape: { top: 22, right: 26, bottom: 26, left: 26, bodyRadius: 36, screenRadius: 16, statusBarHeight: 26, cameraDot: 'left' }
	},
	mobile: {
		portrait: { top: 18, right: 14, bottom: 22, left: 14, bodyRadius: 48, screenRadius: 32, statusBarHeight: 26, notch: 'top' },
		landscape: { top: 14, right: 22, bottom: 14, left: 18, bodyRadius: 48, screenRadius: 32, statusBarHeight: 26, notch: 'left' }
	}
};

export function getFrameMetrics(deviceSize: DeviceSize, rotation: Rotation): DeviceFrameMetrics {
	return FRAME_METRICS[deviceSize][rotation];
}