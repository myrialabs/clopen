import type { Page, Viewport } from 'puppeteer';
import {
	getDeviceEmulation,
	type DeviceEmulationOverrides,
	type DeviceSize,
	type ViewportSize
} from '$shared/constants/preview.js';
import { debug } from '$shared/utils/logger';

/** What a tab's page is emulated as: its class, its size and any device settings on top. */
export interface EmulatedDevice {
	deviceSize: DeviceSize;
	viewport: ViewportSize;
	emulation?: DeviceEmulationOverrides;
}

/**
 * A change to a tab's device settings. A field left out keeps its value;
 * `null` puts it back to what the device would do.
 */
export type EmulationPatch = {
	[K in keyof DeviceEmulationOverrides]?: DeviceEmulationOverrides[K] | null;
};

export function mergeEmulation(
	current: DeviceEmulationOverrides,
	patch: EmulationPatch | null | undefined
): DeviceEmulationOverrides {
	if (!patch) return current;
	const next: DeviceEmulationOverrides = { ...current };
	for (const key of Object.keys(patch) as Array<keyof DeviceEmulationOverrides>) {
		const value = patch[key];
		if (value === undefined) continue;
		if (value === null) delete next[key];
		else (next as Record<string, unknown>)[key] = value;
	}
	return next;
}

/**
 * The full viewport override a tab's page runs under.
 *
 * Every `setViewport` goes through here. Puppeteer replaces the whole override
 * on each call, so a caller that passed only a width and a height — a hot-swap,
 * a restore after fullscreen — silently turned a phone back into a desktop.
 */
export function viewportFor(device: EmulatedDevice): Viewport {
	const { isMobile, hasTouch } = getDeviceEmulation(device.deviceSize, device.emulation);
	return {
		width: device.viewport.width,
		height: device.viewport.height,
		deviceScaleFactor: 1,
		isMobile,
		hasTouch,
		isLandscape: device.viewport.width > device.viewport.height
	};
}

/**
 * Apply a tab's emulation to its page.
 *
 * Turning touch or the mobile viewport on or off makes Puppeteer reload the
 * page: both are fixed when a document is created, so a page that has already
 * run its feature detection would carry on with the old answers. That reload
 * waits for `load`, and a slow page can outlast the navigation timeout — by
 * which point the override has already been applied, so the timeout is not a
 * failure of this call.
 */
export async function applyViewport(page: Page, device: EmulatedDevice): Promise<void> {
	try {
		await page.setViewport(viewportFor(device));
	} catch (error) {
		if (error instanceof Error && error.name === 'TimeoutError') {
			debug.warn('preview', `⏱️ Reload after an emulation change outlasted its timeout; the viewport is applied`);
			return;
		}
		throw error;
	}
}

/**
 * Apply the media-query side of a tab's device settings. An empty value hands
 * the feature back to the browser, so clearing an override is the same call.
 */
export async function applyMediaEmulation(page: Page, emulation: DeviceEmulationOverrides | undefined): Promise<void> {
	await page.emulateMediaFeatures([
		{ name: 'prefers-color-scheme', value: emulation?.colorScheme ?? '' },
		{ name: 'prefers-reduced-motion', value: emulation?.reducedMotion ?? '' }
	]);
}

/** Everything a page needs to look like its tab's device. */
export async function applyDevice(page: Page, device: EmulatedDevice): Promise<void> {
	await applyViewport(page, device);
	await applyMediaEmulation(page, device.emulation);
}
