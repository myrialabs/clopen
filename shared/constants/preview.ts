// Preview Configuration
// Centralized configuration for preview components

/**
 * Device viewport dimensions
 * These are the physical pixel dimensions for each device type.
 * Desktop and laptop are naturally landscape (width > height).
 * Tablet and mobile are naturally portrait (height > width).
 */
export const DEVICE_VIEWPORTS = {
	desktop: { width: 1920, height: 1080 },  // Naturally landscape
	laptop: { width: 1280, height: 800 },    // Naturally landscape
	tablet: { width: 820, height: 1050 },    // Naturally portrait
	mobile: { width: 393, height: 740 }      // Naturally portrait
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