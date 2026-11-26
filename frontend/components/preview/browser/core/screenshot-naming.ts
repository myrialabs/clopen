/**
 * Names and captions for preview screenshots.
 *
 * Pure, so the rules — what a file is called, what the agent is told about an
 * attached image — are the same for every action and can be tested alone.
 */

import type { DeviceSize, ViewportSize } from '$frontend/utils/preview-constants';

export type ScreenshotMode = 'viewport' | 'fullPage' | 'element' | 'region' | 'device';

export interface ScreenshotMeta {
	url: string;
	title: string;
	deviceSize: DeviceSize;
	deviceModel: string | null;
	viewport: ViewportSize;
	mode: ScreenshotMode;
	capturedAt: number;
}

const MODE_SUFFIX: Record<ScreenshotMode, string> = {
	viewport: '',
	fullPage: '-full',
	element: '-element',
	region: '-area',
	device: ''
};

const DEVICE_LABEL: Record<DeviceSize, string> = {
	desktop: 'desktop',
	laptop: 'laptop',
	tablet: 'tablet',
	mobile: 'mobile',
	responsive: 'responsive'
};

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/** `20261126-143005`, in the viewer's local time — what they will look for. */
export function timestampSlug(time: number): string {
	const date = new Date(time);
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	);
}

/** The page's host, or a stand-in for pages that have none (a file, a blank tab). */
export function hostSlug(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.host || (parsed.protocol === 'file:' ? 'file' : '');
		return host.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
	} catch {
		return 'page';
	}
}

/** `localhost-5173-20261126-143005-mobile.png` */
export function screenshotFileName(meta: ScreenshotMeta, extension: 'png' | 'jpg'): string {
	const suffix = meta.mode === 'device' ? `-${DEVICE_LABEL[meta.deviceSize]}` : MODE_SUFFIX[meta.mode];
	return `${hostSlug(meta.url)}-${timestampSlug(meta.capturedAt)}${suffix}.${extension}`;
}

function describeArea(meta: ScreenshotMeta): string {
	switch (meta.mode) {
		case 'fullPage':
			return 'the full page';
		case 'element':
			return 'one element';
		case 'region':
			return 'a selected area';
		default:
			return 'the visible page';
	}
}

/**
 * What the agent is told alongside attached screenshots.
 *
 * An image alone does not say which page it is or how wide the window was,
 * and both decide what "fix this" means — a layout bug at 402px is not one at
 * 1440px.
 */
export function screenshotContext(metas: ScreenshotMeta[]): string {
	if (metas.length === 0) return '';

	const lines = metas.map((meta) => {
		const device = meta.deviceModel ? `${meta.deviceModel}, ` : '';
		const size = `${meta.viewport.width}×${meta.viewport.height}`;
		return `${describeArea(meta)} on ${DEVICE_LABEL[meta.deviceSize]} (${device}${size} viewport)`;
	});

	const first = metas[0];
	const page = first.title && first.title !== first.url ? `${first.title} — ${first.url}` : first.url;
	if (metas.length === 1) return `Screenshot of ${page}: ${lines[0]}.`;
	return `Screenshots of ${page}:\n${lines.map((line, index) => `${index + 1}. ${line}`).join('\n')}`;
}
