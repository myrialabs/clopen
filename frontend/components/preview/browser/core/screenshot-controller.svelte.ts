/**
 * What the preview's screenshot controls do.
 *
 * One place decides every action — the toolbar button and its menu, the
 * page's context menu, the area and element pickers, the editor — so a copy
 * from any of them is the same copy, framed and named the same way, and fails
 * with the same message.
 */

import { addNotification, showNotificationWithActions } from '$frontend/stores/ui/notification.svelte';
import { settings, updateSettings } from '$frontend/stores/features/settings.svelte';
import type { PageColors } from '$frontend/utils/preview-constants';
import type { PreviewScreenshotSettings } from '$shared/types/stores/settings';
import { debug } from '$shared/utils/logger';
import {
	attachToChat,
	canvasToBlob,
	captureResponsive,
	clipboardBlocker,
	captureScreenshot,
	copyImage,
	downloadImage,
	ignoreFolder,
	saveToProject,
	type CaptureContext,
	type ScreenshotFormat,
	type ScreenshotImage,
	type ScreenshotTarget
} from '$frontend/services/preview/browser/screenshot.service';
import { hasDeviceFrame, renderInDeviceFrame } from '$shared/utils/device-frame';
import { screenshotContext, screenshotFileName, type ScreenshotMeta } from './screenshot-naming';

export type ScreenshotDelivery = 'copy' | 'download' | 'attach' | 'save';
export type ScreenshotMenuAction = ScreenshotDelivery | 'annotate' | 'region' | 'element' | 'devices';
export type ScreenshotSelectMode = 'region' | 'element';

/** A finished picture, ready to hand over. */
export interface ScreenshotOutput {
	blob: Blob;
	meta: ScreenshotMeta;
}

/** Devices a responsive capture lays the page out on, smallest first. */
export const RESPONSIVE_DEVICES = ['mobile', 'tablet', 'laptop', 'desktop'] as const;

interface ControllerDeps {
	/** The tab on screen, or null when there is no page to capture. */
	context: () => CaptureContext | null;
	pageColors: () => PageColors | null;
	/** Whether an agent holds the tab — a full-page capture would move the page under it. */
	isAgentHolding: () => boolean;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function extensionOf(blob: Blob): 'png' | 'jpg' {
	return blob.type === 'image/jpeg' ? 'jpg' : 'png';
}

export function preferences(): PreviewScreenshotSettings {
	return settings.previewScreenshot;
}

/** Replace, never mutate: the defaults object is shared with the store's reset. */
export function updatePreferences(patch: Partial<PreviewScreenshotSettings>): void {
	updateSettings({ previewScreenshot: { ...settings.previewScreenshot, ...patch } });
}

/** Whether a capture of this kind can sit in a device mockup. */
export function canFrame(meta: ScreenshotMeta): boolean {
	return (meta.mode === 'viewport' || meta.mode === 'device') && hasDeviceFrame(meta);
}

/** Encode a finished canvas in the chosen format. */
export async function encodeCanvas(canvas: HTMLCanvasElement, format: ScreenshotFormat, quality: number): Promise<Blob> {
	if (format === 'jpeg') {
		// JPEG has no transparency: the mockup's corners would turn black.
		const flat = document.createElement('canvas');
		flat.width = canvas.width;
		flat.height = canvas.height;
		const ctx = flat.getContext('2d');
		if (!ctx) throw new Error('The image could not be encoded');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, flat.width, flat.height);
		ctx.drawImage(canvas, 0, 0);
		return canvasToBlob(flat, format, quality);
	}
	return canvasToBlob(canvas, format, quality);
}

/** The capture inside its device mockup. */
export async function frameImage(
	image: ScreenshotImage,
	pageColors: PageColors | null,
	format: ScreenshotFormat,
	quality: number
): Promise<Blob> {
	const bitmap = await createImageBitmap(image.blob);
	try {
		const framed = renderInDeviceFrame(bitmap, { ...image.meta, pageColors });
		if (!framed) throw new Error('This device has no frame to draw');
		return await encodeCanvas(framed, format, quality);
	} finally {
		bitmap.close();
	}
}

export function createScreenshotController(deps: ControllerDeps) {
	let busy = $state(false);
	let selectMode = $state<ScreenshotSelectMode | null>(null);
	let editorImages = $state<ScreenshotImage[] | null>(null);

	function requireContext(): CaptureContext {
		const context = deps.context();
		if (!context) throw new Error('There is no page to capture yet');
		return context;
	}

	/** Full page when asked for and allowed; the toggle says when it is not. */
	function primaryTarget(): ScreenshotTarget {
		return preferences().fullPage && !deps.isAgentHolding() ? { kind: 'fullPage' } : { kind: 'viewport' };
	}

	function fail(title: string, error: unknown): void {
		debug.warn('preview', `${title}:`, error);
		addNotification({ type: 'error', title, message: errorMessage(error), duration: 6000 });
	}

	/** Capture and, when the preference asks for it and the capture allows it, frame. */
	async function captureFinished(target: ScreenshotTarget, format: ScreenshotFormat): Promise<ScreenshotOutput> {
		const { quality, deviceFrame } = preferences();
		// A framed picture is re-encoded after framing, so it is captured lossless.
		const frame = deviceFrame && target.kind === 'viewport';
		const image = await captureScreenshot(requireContext(), target, frame ? 'png' : format, quality);
		if (frame && canFrame(image.meta)) {
			return { blob: await frameImage(image, deps.pageColors(), format, quality), meta: image.meta };
		}
		return { blob: image.blob, meta: image.meta };
	}

	async function saveOutput(output: ScreenshotOutput): Promise<void> {
		const folder = preferences().folder;
		const saved = await saveToProject(output.blob, screenshotFileName(output.meta, extensionOf(output.blob)), folder);
		if (saved.git !== 'not-ignored') {
			addNotification({ type: 'success', title: 'Screenshot saved', message: saved.path, duration: 4000 });
			return;
		}

		// Saved where git would pick it up: say so, and offer the one-step fix.
		showNotificationWithActions(
			'warning',
			'Screenshot saved — git will track it',
			`${saved.path} is not ignored, so it can end up in a commit. Add ${saved.folder}/ to .gitignore?`,
			[
				{
					label: 'Add to .gitignore',
					action: () => {
						ignoreFolder(saved.folder)
							.then((state) => {
								addNotification(
									state === 'ignored'
										? { type: 'success', title: 'Folder ignored', message: `${saved.folder}/ was added to .gitignore`, duration: 4000 }
										: {
												type: 'warning',
												title: 'Still tracked',
												message: `${saved.folder}/ was added to .gitignore, but another rule makes git track it anyway`,
												duration: 6000
											}
								);
							})
							.catch((error) => fail('Could not update .gitignore', error));
					}
				}
			],
			12000
		);
	}

	/** Hand finished pictures over. Copy must be called straight from a click. */
	async function deliver(action: ScreenshotDelivery, outputs: ScreenshotOutput[] | Promise<ScreenshotOutput[]>): Promise<void> {
		if (action === 'copy') {
			// The clipboard write starts now, inside the gesture; the image follows.
			const pending = Promise.resolve(outputs);
			await copyImage(pending.then((list) => list[0].blob));
			addNotification({ type: 'success', title: 'Screenshot copied', message: 'Ready to paste', duration: 2500 });
			return;
		}

		const list = await outputs;
		switch (action) {
			case 'download':
				for (const output of list) downloadImage(output.blob, screenshotFileName(output.meta, extensionOf(output.blob)));
				return;
			case 'attach':
				await attachToChat(
					list.map((output) => ({ blob: output.blob, fileName: screenshotFileName(output.meta, extensionOf(output.blob)) })),
					screenshotContext(list.map((output) => output.meta))
				);
				addNotification({
					type: 'success',
					title: list.length > 1 ? 'Screenshots attached' : 'Screenshot attached',
					message: 'Added to the message box of the open chat',
					duration: 3000
				});
				return;
			case 'save':
				for (const output of list) await saveOutput(output);
				return;
		}
	}

	const failureTitle: Record<ScreenshotDelivery, string> = {
		copy: 'Could not copy the screenshot',
		download: 'Could not download the screenshot',
		attach: 'Could not attach the screenshot',
		save: 'Could not save the screenshot'
	};

	/** A toolbar action on the current page, in the preferred format. */
	function quick(action: ScreenshotDelivery): void {
		if (busy) return;

		// Checked before capturing: there is no point taking a picture the
		// clipboard will refuse. The way out is offered, not taken for them.
		const blocker = action === 'copy' ? clipboardBlocker() : null;
		if (blocker) {
			showNotificationWithActions('error', 'Cannot copy images here', blocker, [
				{ label: 'Download instead', action: () => quick('download') }
			]);
			return;
		}

		busy = true;
		const format = action === 'copy' ? 'png' : preferences().format;
		// Not awaited before the delivery starts: a copy has to begin inside the click.
		const outputs = captureFinished(primaryTarget(), format).then((output) => [output]);
		deliver(action, outputs)
			.catch((error) => fail(failureTitle[action], error))
			.finally(() => (busy = false));
	}

	async function openEditor(load: () => Promise<ScreenshotImage[]>, failure: string): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			editorImages = await load();
		} catch (error) {
			fail(failure, error);
		} finally {
			busy = false;
		}
	}

	function annotate(target: ScreenshotTarget = primaryTarget()): Promise<void> {
		return openEditor(
			async () => [await captureScreenshot(requireContext(), target, 'png', preferences().quality)],
			'Could not take the screenshot'
		);
	}

	function captureDevices(): Promise<void> {
		return openEditor(
			() => captureResponsive(requireContext().tabId, [...RESPONSIVE_DEVICES], 'png', preferences().quality),
			'Could not capture the device sizes'
		);
	}

	return {
		get busy() {
			return busy;
		},
		get selectMode() {
			return selectMode;
		},
		get editorImages() {
			return editorImages;
		},
		/** Whether the full-page preference can be honoured right now. */
		get fullPageAvailable() {
			return !deps.isAgentHolding();
		},

		runMenuAction(action: ScreenshotMenuAction): void {
			switch (action) {
				case 'copy':
				case 'download':
				case 'attach':
				case 'save':
					quick(action);
					return;
				case 'annotate':
					void annotate();
					return;
				case 'region':
				case 'element':
					selectMode = action;
					return;
				case 'devices':
					void captureDevices();
					return;
			}
		},

		/** A screenshot entry from the page's own context menu, at the point it was opened. */
		runContextMenuItem(itemId: string, point: { x: number; y: number }): boolean {
			switch (itemId) {
				case 'screenshot-copy':
					quick('copy');
					return true;
				case 'screenshot-element':
					void annotate({ kind: 'element', x: point.x, y: point.y });
					return true;
				case 'screenshot-annotate':
					void annotate();
					return true;
				default:
					return false;
			}
		},

		/** The area or element the picker settled on. */
		completeSelection(target: ScreenshotTarget): void {
			selectMode = null;
			void annotate(target);
		},

		cancelSelection(): void {
			selectMode = null;
		},

		closeEditor(): void {
			editorImages = null;
		},

		/** From the editor: hand over what it rendered. */
		deliverFromEditor(action: ScreenshotDelivery, outputs: Promise<ScreenshotOutput[]>): Promise<void> {
			return deliver(action, outputs).catch((error) => fail(failureTitle[action], error));
		}
	};
}

export type ScreenshotController = ReturnType<typeof createScreenshotController>;
