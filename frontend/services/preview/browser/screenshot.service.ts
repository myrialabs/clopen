/**
 * Preview screenshots — capture and delivery.
 *
 * Capture is always the backend's: the page is rendered by its own browser at
 * the emulated viewport's resolution. There is deliberately no second path
 * that reads the picture off the stream — that picture is sized for whoever
 * is watching and compressed for the wire, so it would quietly hand over a
 * worse image. A capture that fails is reported as failed.
 *
 * Delivery is the viewer's: the clipboard, the device's Downloads folder, the
 * open chat's message box, or a file in the workspace.
 */

import ws from '$frontend/utils/ws';
import { addToComposer } from '$frontend/stores/ui/chat-input.svelte';
import { sessionState } from '$frontend/stores/core/sessions.svelte';
import { MAX_ATTACHMENT_BYTES } from '$shared/constants/attachments';
import type { DeviceSize } from '$frontend/utils/preview-constants';
import type { ScreenshotMeta } from '$frontend/components/preview/browser/core/screenshot-naming';

export type ScreenshotFormat = 'png' | 'jpeg';

export type ScreenshotTarget =
	| { kind: 'viewport' }
	| { kind: 'fullPage' }
	| { kind: 'element'; x: number; y: number; depth?: number }
	| { kind: 'region'; x: number; y: number; width: number; height: number };

export interface ScreenshotImage {
	blob: Blob;
	width: number;
	height: number;
	meta: ScreenshotMeta;
}

export interface PickedElement {
	rect: { x: number; y: number; width: number; height: number };
	label: string;
	depth: number;
	hasParent: boolean;
}

export type GitIgnoreState = 'ignored' | 'not-ignored' | 'no-repo';

const CAPTURE_TIMEOUT_MS = 60_000;
const RESPONSIVE_TIMEOUT_MS = 180_000;

function base64ToBlob(data: string, mimeType: string): Blob {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return new Blob([bytes], { type: mimeType });
}

export async function blobToBase64(blob: Blob): Promise<string> {
	const buffer = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	const chunk = 0x8000;
	for (let index = 0; index < buffer.length; index += chunk) {
		binary += String.fromCharCode(...buffer.subarray(index, index + chunk));
	}
	return btoa(binary);
}

/** The page context every capture of a tab carries. */
export interface CaptureContext {
	tabId: string;
	deviceSize: DeviceSize;
	deviceModel: string | null;
	viewport: { width: number; height: number };
}

export async function captureScreenshot(
	context: CaptureContext,
	target: ScreenshotTarget,
	format: ScreenshotFormat,
	quality: number
): Promise<ScreenshotImage> {
	const result = await ws.http(
		'preview:browser-screenshot',
		{ tabId: context.tabId, target, format, quality: format === 'jpeg' ? quality : undefined },
		CAPTURE_TIMEOUT_MS
	);
	return {
		blob: base64ToBlob(result.image.data, result.image.mimeType),
		width: result.image.width,
		height: result.image.height,
		meta: {
			url: result.url,
			title: result.title,
			deviceSize: context.deviceSize,
			deviceModel: context.deviceModel,
			viewport: context.viewport,
			mode: target.kind,
			capturedAt: Date.now()
		}
	};
}

/** The page as it lays out on each device, captured without touching the tab. */
export async function captureResponsive(
	tabId: string,
	devices: Exclude<DeviceSize, 'responsive'>[],
	format: ScreenshotFormat,
	quality: number
): Promise<ScreenshotImage[]> {
	const result = await ws.http(
		'preview:browser-screenshot-responsive',
		{ tabId, devices, format, quality: format === 'jpeg' ? quality : undefined },
		RESPONSIVE_TIMEOUT_MS
	);
	const capturedAt = Date.now();
	return result.shots.map((shot) => ({
		blob: base64ToBlob(shot.image.data, shot.image.mimeType),
		width: shot.image.width,
		height: shot.image.height,
		meta: {
			url: result.url,
			title: result.title,
			deviceSize: shot.deviceSize as DeviceSize,
			deviceModel: shot.deviceModel,
			viewport: shot.viewport,
			mode: 'device',
			capturedAt
		}
	}));
}

export async function elementAt(tabId: string, x: number, y: number, depth: number): Promise<PickedElement | null> {
	const result = await ws.http('preview:browser-screenshot-element-at', { tabId, x, y, depth }, 5000);
	return result.element;
}

// ── Delivery ──────────────────────────────────────────────────────────

/**
 * Why the clipboard cannot take an image here, or null when it can.
 *
 * Browsers only hand out image clipboard access to secure pages — HTTPS or
 * localhost. Clopen reached over plain HTTP on a network address is neither.
 */
export function clipboardBlocker(): string | null {
	if (typeof window === 'undefined') return 'No clipboard is available here';
	if (!window.isSecureContext) {
		return 'Your browser only lets secure pages (HTTPS or localhost) copy images. Download the screenshot instead, or open Clopen over HTTPS.';
	}
	if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
		return 'This browser cannot copy images to the clipboard. Download the screenshot instead.';
	}
	return null;
}

/** A PNG of any image the browser can decode — the only type clipboards accept. */
export async function toPng(blob: Blob): Promise<Blob> {
	if (blob.type === 'image/png') return blob;
	const bitmap = await createImageBitmap(blob);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
		return await canvasToBlob(canvas, 'png', 1);
	} finally {
		bitmap.close();
	}
}

export function canvasToBlob(canvas: HTMLCanvasElement, format: ScreenshotFormat, quality: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded'))),
			format === 'jpeg' ? 'image/jpeg' : 'image/png',
			format === 'jpeg' ? quality / 100 : undefined
		);
	});
}

/**
 * Put an image on the clipboard.
 *
 * Takes a promise on purpose and must be called straight from the click: the
 * clipboard only accepts a write made during a user gesture, and the capture
 * is a round-trip to the server. Handing `ClipboardItem` the pending image
 * keeps the write inside the gesture while the image is still on its way —
 * Safari refuses anything else.
 */
export async function copyImage(image: Promise<Blob>): Promise<void> {
	const blocker = clipboardBlocker();
	if (blocker) throw new Error(blocker);
	await navigator.clipboard.write([new ClipboardItem({ 'image/png': image.then(toPng) })]);
}

/** Save to the device. Browsers put it in the user's Downloads folder. */
export function downloadImage(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = fileName;
	document.body.appendChild(link);
	link.click();
	link.remove();
	// Revoked a beat later: some browsers start reading the blob after the click returns.
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Whether there is a chat open to attach to. */
export function hasOpenChat(): boolean {
	return !!sessionState.currentSession?.id;
}

export async function saveToProject(
	blob: Blob,
	fileName: string,
	folder: string
): Promise<{ path: string; folder: string; git: GitIgnoreState }> {
	return ws.http(
		'preview:browser-screenshot-save',
		{
			fileName,
			data: await blobToBase64(blob),
			mimeType: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
			folder
		},
		CAPTURE_TIMEOUT_MS
	);
}

export async function ignoreFolder(folder: string): Promise<GitIgnoreState> {
	const result = await ws.http('preview:browser-screenshot-ignore-folder', { folder }, 15_000);
	return result.git;
}
