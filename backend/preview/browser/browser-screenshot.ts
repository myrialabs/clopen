/**
 * Preview screenshots.
 *
 * The one capture path for every picture taken of a preview page: the
 * toolbar, the context menu and the agent's `screenshot` action all come
 * through here. The image is rendered by the page's own browser at the
 * emulated viewport's resolution — never read off the stream, whose size and
 * quality follow whoever happens to be watching.
 *
 * Coordinates handed in are page CSS pixels in the *viewport* (what the viewer
 * pointed at); `Page.captureScreenshot` wants them in the *document*, so the
 * scroll offset is added here and nowhere else.
 */

import type { Page } from 'puppeteer';
import type { DeviceSize, ViewportSize } from '$shared/constants/preview';
import { drawDeviceFrame, type FrameDrawInput } from '$shared/utils/device-frame';

export type ScreenshotFormat = 'png' | 'jpeg';

export type ScreenshotTarget =
	/** What is on screen. */
	| { kind: 'viewport' }
	/** The whole scrollable document. */
	| { kind: 'fullPage' }
	/** The first element matching a CSS selector. */
	| { kind: 'selector'; selector: string }
	/** The element under a viewport point, `depth` ancestors up. */
	| { kind: 'element'; x: number; y: number; depth?: number }
	/** A rectangle of the viewport. */
	| { kind: 'region'; x: number; y: number; width: number; height: number };

export interface ScreenshotOptions {
	format?: ScreenshotFormat;
	/** JPEG quality, 1–100. Ignored for PNG. */
	quality?: number;
}

export interface CapturedScreenshot {
	data: Uint8Array;
	mimeType: 'image/png' | 'image/jpeg';
	width: number;
	height: number;
}

/** Who asked: the viewer's controls, or an agent's `screenshot` action. */
export type ScreenshotSource = 'user' | 'agent';

/** One device's picture from a responsive capture. */
export interface ResponsiveScreenshot {
	deviceSize: DeviceSize;
	deviceModel: string | null;
	viewport: ViewportSize;
	image: CapturedScreenshot;
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** What sits under a point, as the element picker shows it. */
export interface ElementAtPoint {
	/** In viewport coordinates — where to draw the highlight. */
	rect: Rect;
	/** `tag#id.class`, for the picker's label. */
	label: string;
	/** The depth actually reached; lower than asked when the root was hit. */
	depth: number;
	/** Whether there is an ancestor above this one to step out to. */
	hasParent: boolean;
}

interface ResolvedElement extends ElementAtPoint {
	scrollX: number;
	scrollY: number;
	viewportWidth: number;
	viewportHeight: number;
	documentWidth: number;
	documentHeight: number;
}

export const DEFAULT_JPEG_QUALITY = 80;

/** How long a single capture may take before it is reported as failed. */
const CAPTURE_TIMEOUT_MS = 20_000;
const FULL_PAGE_TIMEOUT_MS = 45_000;

export function mimeTypeFor(format: ScreenshotFormat): CapturedScreenshot['mimeType'] {
	return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

/**
 * Pixel size of a PNG or JPEG, read from its header.
 *
 * Read from the bytes rather than predicted from the clip: Chrome rounds clips,
 * intersects them with the viewport and applies the device scale factor, so
 * the size asked for is not reliably the size returned.
 */
export function readImageSize(bytes: Uint8Array): { width: number; height: number } | null {
	// PNG: 8-byte signature, then the IHDR chunk with width and height.
	if (
		bytes.length >= 24 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		return { width: view.getUint32(16), height: view.getUint32(20) };
	}

	// JPEG: walk the segments to the first start-of-frame marker.
	if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) return null;
			const marker = bytes[offset + 1];
			// Fill bytes between segments.
			if (marker === 0xff) {
				offset += 1;
				continue;
			}
			const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
			const isStartOfFrame =
				marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isStartOfFrame) {
				return {
					height: (bytes[offset + 5] << 8) | bytes[offset + 6],
					width: (bytes[offset + 7] << 8) | bytes[offset + 8]
				};
			}
			offset += 2 + length;
		}
	}

	return null;
}

/**
 * A viewport rectangle as a document clip, kept inside the viewport.
 *
 * A drag can start or end outside the page, and a rectangle that reaches past
 * it would make Chrome capture blank canvas beyond the edge.
 */
export function regionToClip(
	region: Rect,
	viewport: { width: number; height: number },
	scroll: { x: number; y: number }
): Rect | null {
	const left = Math.max(0, Math.min(region.x, region.x + region.width));
	const top = Math.max(0, Math.min(region.y, region.y + region.height));
	const right = Math.min(viewport.width, Math.max(region.x, region.x + region.width));
	const bottom = Math.min(viewport.height, Math.max(region.y, region.y + region.height));

	const width = Math.round(right - left);
	const height = Math.round(bottom - top);
	if (width < 1 || height < 1) return null;

	return { x: Math.round(left + scroll.x), y: Math.round(top + scroll.y), width, height };
}

/**
 * An element's box as a document clip.
 *
 * `beyondViewport` is only asked for when the element does not fit on screen:
 * capturing beyond the viewport makes Chrome lay the page out at its full
 * height for a moment, which every viewer of the stream sees as a flicker.
 */
export function elementToClip(element: ResolvedElement): { clip: Rect; beyondViewport: boolean } | null {
	const { rect } = element;
	const left = Math.max(0, rect.x + element.scrollX);
	const top = Math.max(0, rect.y + element.scrollY);
	const right = Math.min(element.documentWidth, rect.x + rect.width + element.scrollX);
	const bottom = Math.min(element.documentHeight, rect.y + rect.height + element.scrollY);

	const width = Math.round(right - left);
	const height = Math.round(bottom - top);
	if (width < 1 || height < 1) return null;

	const fits =
		rect.x >= -0.5 &&
		rect.y >= -0.5 &&
		rect.x + rect.width <= element.viewportWidth + 0.5 &&
		rect.y + rect.height <= element.viewportHeight + 0.5;

	return {
		clip: { x: Math.round(left), y: Math.round(top), width, height },
		beyondViewport: !fits
	};
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function resolveElement(page: Page, x: number, y: number, depth: number): Promise<ResolvedElement | null> {
	return page.evaluate(
		(point: { x: number; y: number; depth: number }) => {
			let element = document.elementFromPoint(point.x, point.y);
			if (!element) return null;

			let reached = 0;
			while (reached < point.depth && element.parentElement) {
				element = element.parentElement;
				reached += 1;
			}

			const box = element.getBoundingClientRect();
			const classes = Array.from(element.classList).slice(0, 2);
			const label =
				element.tagName.toLowerCase() +
				(element.id ? `#${element.id}` : '') +
				(classes.length ? `.${classes.join('.')}` : '');
			const root = document.documentElement;

			return {
				rect: { x: box.left, y: box.top, width: box.width, height: box.height },
				label,
				depth: reached,
				hasParent: !!element.parentElement,
				scrollX: window.scrollX,
				scrollY: window.scrollY,
				viewportWidth: window.innerWidth,
				viewportHeight: window.innerHeight,
				documentWidth: Math.max(root.scrollWidth, root.clientWidth),
				documentHeight: Math.max(root.scrollHeight, root.clientHeight)
			};
		},
		{ x, y, depth: Math.max(0, Math.floor(depth)) }
	);
}

/** The element under a viewport point, for the picker's highlight. */
export async function elementAtPoint(page: Page, x: number, y: number, depth = 0): Promise<ElementAtPoint | null> {
	const element = await withTimeout(resolveElement(page, x, y, depth), 5000, 'The page did not answer in time');
	if (!element) return null;
	return { rect: element.rect, label: element.label, depth: element.depth, hasParent: element.hasParent };
}

function finish(data: Uint8Array, format: ScreenshotFormat): CapturedScreenshot {
	const size = readImageSize(data);
	if (!size) throw new Error('The browser returned an image that could not be read');
	return { data, mimeType: mimeTypeFor(format), ...size };
}

/**
 * Capture a page.
 *
 * Throws with a message fit to show the user: every failure here — a page
 * gone mid-capture, an element that does not exist, a capture that never
 * returns — is reported, never papered over with a lesser picture.
 */
export async function captureScreenshot(
	page: Page,
	target: ScreenshotTarget,
	options: ScreenshotOptions = {}
): Promise<CapturedScreenshot> {
	if (page.isClosed()) throw new Error('The page is closed');

	const format = options.format ?? 'png';
	const base = {
		type: format,
		...(format === 'jpeg' ? { quality: options.quality ?? DEFAULT_JPEG_QUALITY } : {})
	} as const;

	switch (target.kind) {
		case 'viewport': {
			const data = await withTimeout(
				page.screenshot({ ...base, captureBeyondViewport: false }),
				CAPTURE_TIMEOUT_MS,
				'The screenshot took too long'
			);
			return finish(data, format);
		}

		case 'fullPage': {
			const data = await withTimeout(
				page.screenshot({ ...base, fullPage: true }),
				FULL_PAGE_TIMEOUT_MS,
				'The full-page screenshot took too long'
			);
			return finish(data, format);
		}

		case 'selector': {
			const element = await page.$(target.selector);
			if (!element) throw new Error(`No element matched "${target.selector}"`);
			try {
				const data = await withTimeout(
					element.screenshot(base),
					CAPTURE_TIMEOUT_MS,
					'The element screenshot took too long'
				);
				return finish(data, format);
			} finally {
				await element.dispose().catch(() => {});
			}
		}

		case 'element': {
			const element = await resolveElement(page, target.x, target.y, target.depth ?? 0);
			if (!element) throw new Error('There is no element at that point');
			const resolved = elementToClip(element);
			if (!resolved) throw new Error('That element has no visible size');
			const data = await withTimeout(
				page.screenshot({ ...base, clip: resolved.clip, captureBeyondViewport: resolved.beyondViewport }),
				CAPTURE_TIMEOUT_MS,
				'The element screenshot took too long'
			);
			return finish(data, format);
		}

		case 'region': {
			const metrics = await page.evaluate(() => ({
				width: window.innerWidth,
				height: window.innerHeight,
				x: window.scrollX,
				y: window.scrollY
			}));
			const clip = regionToClip(target, metrics, metrics);
			if (!clip) throw new Error('The selected area is empty');
			const data = await withTimeout(
				page.screenshot({ ...base, clip, captureBeyondViewport: false }),
				CAPTURE_TIMEOUT_MS,
				'The screenshot took too long'
			);
			return finish(data, format);
		}
	}
}

/**
 * Put a capture inside its device mockup.
 *
 * The server has no canvas, so the mockup is drawn by the same function the
 * viewer uses, run inside a page of the preview browser — one renderer, so a
 * frame from the agent and a frame from the toolbar are the same picture.
 * The page should be a scratch page: nothing here belongs in a tab's page.
 */
export async function frameScreenshot(
	page: Page,
	image: CapturedScreenshot,
	input: FrameDrawInput,
	options: ScreenshotOptions = {}
): Promise<CapturedScreenshot> {
	const format = options.format ?? 'png';
	const source = `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`;

	const dataUrl = await withTimeout(
		page.evaluate(
			async (src: string, frame: FrameDrawInput, drawSource: string, jpeg: boolean, quality: number) => {
				const picture = new Image();
				picture.src = src;
				await picture.decode();
				const draw = new Function(`return (${drawSource})`)() as typeof drawDeviceFrame;
				const framed = draw(picture, frame);
				if (!framed) return null;
				if (!jpeg) return framed.toDataURL('image/png');

				// JPEG has no transparency: the mockup's corners would turn black.
				const flat = document.createElement('canvas');
				flat.width = framed.width;
				flat.height = framed.height;
				const ctx = flat.getContext('2d');
				if (!ctx) return null;
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, flat.width, flat.height);
				ctx.drawImage(framed, 0, 0);
				return flat.toDataURL('image/jpeg', quality / 100);
			},
			source,
			input,
			drawDeviceFrame.toString(),
			format === 'jpeg',
			options.quality ?? DEFAULT_JPEG_QUALITY
		),
		CAPTURE_TIMEOUT_MS,
		'Drawing the device frame took too long'
	);
	if (!dataUrl) throw new Error('The device frame could not be drawn');

	return finish(new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')), format);
}
