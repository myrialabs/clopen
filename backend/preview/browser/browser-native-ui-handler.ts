import { EventEmitter } from 'events';
import type { Frame, Page } from 'puppeteer';
import type {
	BrowserTab,
	BrowserSelectInfo,
	BrowserSelectResponse,
	BrowserContextMenuInfo,
	BrowserContextMenuResponse,
	BrowserContextMenuItem,
	BrowserNativePickerInfo
} from './types';
import { resolveFrameTarget } from './frame-targeting';
import { debug } from '$shared/utils/logger';
import { nanoid } from 'nanoid';

/**
 * Read the current text selection from wherever it actually lives.
 *
 * A selection inside an iframe is invisible to the top document, so asking only
 * the main frame returns an empty string for exactly the pages most likely to
 * be embedding content. `cut` additionally deletes it in the frame that owns it.
 */
async function readSelection(page: Page, deleteAfter = false): Promise<string> {
	for (const frame of page.frames()) {
		try {
			const text = await frame.evaluate((remove: boolean) => {
				const selected = window.getSelection()?.toString() ?? '';
				if (selected && remove) document.execCommand('delete');
				return selected;
			}, deleteAfter);
			if (text) return text;
		} catch {
			// Detached or cross-origin mid-navigation; keep looking.
		}
	}
	return '';
}

/**
 * Browser Native UI Handler
 *
 * Handles OS-native UI elements that cannot be rendered in headless browser:
 * - <select> dropdown menus
 * - Context menus (right-click)
 *
 * Detects these elements, extracts their data, and emits events to frontend
 * for rendering as overlay components positioned over the canvas.
 */
export class BrowserNativeUIHandler extends EventEmitter {
	constructor() {
		super();
	}

	/**
	 * Check if clicked element is a <select> and extract options
	 */
	async checkForSelect(sessionId: string, page: Page, x: number, y: number): Promise<BrowserSelectInfo | null> {
		try {
			// Generate unique select ID
			const selectId = nanoid(10);

			// Resolve which frame owns the point first. Evaluating against the main
			// frame would find the `<iframe>` element rather than the select inside
			// it, which is why selects in embedded pages never opened.
			const target = await resolveFrameTarget(page, x, y);

			const selectData = await target.frame.evaluate((params) => {
				const { x, y, selectId } = params;
				const element = document.elementFromPoint(x, y);

				if (!element) return null;

				// Check if element is a select or inside a select
				let selectElement: HTMLSelectElement | null = null;
				if (element.tagName === 'SELECT') {
					selectElement = element as HTMLSelectElement;
				} else {
					selectElement = element.closest('select') as HTMLSelectElement;
				}

				if (!selectElement) return null;

				// A `size > 1` or `multiple` select renders as an inline list box that
				// the page already paints — it has no popup to stand in for, and
				// intercepting its clicks would break selection outright.
				if (selectElement.multiple || selectElement.size > 1) return null;
				if (selectElement.disabled) return null;

				// IMPORTANT: Mark this select element with unique ID for later reference
				selectElement.setAttribute('data-puppeteer-select-id', selectId);

				// Walk the children rather than `.options`, so `<optgroup>` labels and
				// grouping survive instead of being flattened into a single list.
				const options: Array<{
					index: number;
					value: string;
					text: string;
					selected: boolean;
					disabled?: boolean;
					group?: string;
					groupDisabled?: boolean;
				}> = [];

				const pushOption = (option: HTMLOptionElement, group?: HTMLOptGroupElement) => {
					options.push({
						index: option.index,
						value: option.value || '',
						text: option.label || option.textContent || '',
						selected: option.selected,
						// An option inside a disabled group is unusable even when the
						// option itself carries no disabled attribute.
						disabled: option.disabled || !!group?.disabled,
						group: group?.label || undefined,
						groupDisabled: group?.disabled || undefined
					});
				};

				for (const child of Array.from(selectElement.children)) {
					if (child.tagName === 'OPTGROUP') {
						const group = child as HTMLOptGroupElement;
						for (const option of Array.from(group.children)) {
							if (option.tagName === 'OPTION') pushOption(option as HTMLOptionElement, group);
						}
					} else if (child.tagName === 'OPTION') {
						pushOption(child as HTMLOptionElement);
					}
				}

				// Get bounding box
				const rect = selectElement.getBoundingClientRect();
				const boundingBox = {
					x: rect.left,
					y: rect.top,
					width: rect.width,
					height: rect.height
				};

				return {
					options,
					selectedIndex: selectElement.selectedIndex,
					boundingBox
				};
			}, { x: target.x, y: target.y, selectId });

			if (!selectData) return null;

			// The box came back in the owning frame's coordinates; shift it back
			// into page space so the overlay lands over the real element.
			const offsetX = x - target.x;
			const offsetY = y - target.y;

			const selectInfo: any = {
				sessionId, // Internal use only, converted to tabId at previewService layer
				selectId,
				x,
				y,
				boundingBox: {
					x: selectData.boundingBox.x + offsetX,
					y: selectData.boundingBox.y + offsetY,
					width: selectData.boundingBox.width,
					height: selectData.boundingBox.height
				},
				options: selectData.options,
				selectedIndex: selectData.selectedIndex,
				timestamp: Date.now()
			};

			debug.log('preview', `📋 Select element detected at (${x}, ${y}) with ${selectData.options.length} options`);
			return selectInfo;
		} catch (error) {
			debug.error('preview', 'Error checking for select element:', error);
			return null;
		}
	}

	/**
	 * Detect a native input whose picker Chrome renders outside the page — a
	 * colour swatch or a date field. Those popups are drawn by the browser
	 * process and never reach the screencast, so the viewer has to supply one.
	 */
	async checkForNativePicker(
		sessionId: string,
		page: Page,
		x: number,
		y: number
	): Promise<BrowserNativePickerInfo | null> {
		try {
			const pickerId = nanoid(10);
			const target = await resolveFrameTarget(page, x, y);

			const data = await target.frame.evaluate((params) => {
				const { x, y, pickerId } = params;
				const element = document.elementFromPoint(x, y);
				if (!element || element.tagName !== 'INPUT') return null;

				const input = element as HTMLInputElement;
				const type = (input.type || '').toLowerCase();
				const PICKER_TYPES = ['color', 'date', 'datetime-local', 'month', 'time', 'week'];
				if (!PICKER_TYPES.includes(type)) return null;
				if (input.disabled || input.readOnly) return null;

				input.setAttribute('data-clopen-picker-id', pickerId);

				const rect = input.getBoundingClientRect();
				return {
					inputType: type,
					value: input.value,
					min: input.min || undefined,
					max: input.max || undefined,
					step: input.step || undefined,
					boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
				};
			}, { x: target.x, y: target.y, pickerId });

			if (!data) return null;

			const offsetX = x - target.x;
			const offsetY = y - target.y;

			return {
				sessionId,
				pickerId,
				inputType: data.inputType as BrowserNativePickerInfo['inputType'],
				value: data.value,
				min: data.min,
				max: data.max,
				step: data.step,
				boundingBox: {
					x: data.boundingBox.x + offsetX,
					y: data.boundingBox.y + offsetY,
					width: data.boundingBox.width,
					height: data.boundingBox.height
				},
				timestamp: Date.now()
				// sessionId is converted to tabId at the previewService layer, the
				// same handoff the select and context-menu payloads use.
			} as unknown as BrowserNativePickerInfo;
		} catch (error) {
			debug.error('preview', 'Error checking for native picker:', error);
			return null;
		}
	}

	/**
	 * Write a value chosen in the viewer's own picker back into the page.
	 */
	async handleNativePickerResponse(page: Page, pickerId: string, value: string): Promise<boolean> {
		for (const frame of page.frames()) {
			try {
				const applied = await frame.evaluate(
					(params) => {
						const input = document.querySelector(
							`input[data-clopen-picker-id="${params.pickerId}"]`
						) as HTMLInputElement | null;
						if (!input) return false;

						input.value = params.value;
						input.dispatchEvent(new Event('input', { bubbles: true }));
						input.dispatchEvent(new Event('change', { bubbles: true }));
						input.removeAttribute('data-clopen-picker-id');
						return true;
					},
					{ pickerId, value }
				);
				if (applied) return true;
			} catch {
				// Frame went away or is cross-origin mid-navigation; keep looking.
			}
		}
		return false;
	}

	/**
	 * Handle select option selection from frontend
	 */
	async handleSelectResponse(page: Page, response: BrowserSelectResponse): Promise<boolean> {
		const { selectId, selectedIndex } = response;

		// The marked select may live in any frame, and only the frame that owns it
		// can see the marker — so every frame is asked until one claims it.
		for (const frame of page.frames()) {
			try {
				const applied = await this.applySelectResponse(frame, selectId, selectedIndex);
				if (applied) return true;
			} catch {
				// Detached or cross-origin mid-navigation; try the next frame.
			}
		}

		debug.warn('preview', `⚠️ Select element ${selectId} not found in any frame`);
		return false;
	}

	private async applySelectResponse(
		frame: Frame,
		selectId: string,
		selectedIndex: number
	): Promise<boolean> {
		try {
			// Update the select value in the page
			const result = await frame.evaluate((params) => {
				const { selectId, index } = params;

				// Find the select element by the unique ID we set earlier
				const selectElement = document.querySelector(`select[data-puppeteer-select-id="${selectId}"]`) as HTMLSelectElement;

				// Absent here just means the select lives in a different frame —
				// the caller keeps asking, so this must stay quiet.
				if (!selectElement) return false;

				if (index < 0 || index >= selectElement.options.length) {
					console.error(`Invalid option index: ${index}`);
					return false;
				}

				// Update selected index
				selectElement.selectedIndex = index;

				// Trigger change event
				const changeEvent = new Event('change', { bubbles: true });
				selectElement.dispatchEvent(changeEvent);

				// Trigger input event for React/Vue compatibility
				const inputEvent = new Event('input', { bubbles: true });
				selectElement.dispatchEvent(inputEvent);

				// Clean up the tracking attribute
				selectElement.removeAttribute('data-puppeteer-select-id');

				return true;
			}, { selectId, index: selectedIndex });

			if (result) {
				debug.log('preview', `✅ Select option updated to index: ${selectedIndex}`);
			}

			return result;
		} catch (error) {
			debug.error('preview', 'Error handling select response:', error);
			return false;
		}
	}

	/**
	 * Check element at coordinates and build context menu
	 */
	async checkForContextMenu(
		sessionId: string,
		page: Page,
		x: number,
		y: number,
		navigation?: { canGoBack: boolean; canGoForward: boolean }
	): Promise<BrowserContextMenuInfo | null> {
		try {
			// Same reason as the select path: inside an iframe the main frame only
			// ever reports the `<iframe>` element, so the menu came back describing
			// the frame rather than whatever was actually right-clicked.
			const target = await resolveFrameTarget(page, x, y);

			const contextData = await target.frame.evaluate((coordinates) => {
				const { x, y } = coordinates;
				const element = document.elementFromPoint(x, y);

				if (!element) return null;

				// Get element information
				const tagName = element.tagName;
				const anchor = (element.tagName === 'A' ? element : element.closest('a')) as HTMLAnchorElement | null;
				const isLink = !!anchor;
				const isImage = element.tagName === 'IMG';
				const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
				// contenteditable regions accept the same edit commands as a real
				// input, and every rich-text editor on the web is built on them.
				const isEditable = isInput || (element as HTMLElement).isContentEditable;

				const mediaElement = (
					element.tagName === 'VIDEO' || element.tagName === 'AUDIO' ? element : null
				) as HTMLMediaElement | null;

				// Check for text selection
				const selection = window.getSelection();
				const selectedText = selection ? selection.toString() : '';
				const isTextSelected = selectedText.length > 0;

				let inputType: string | undefined;
				if (isInput && element.tagName === 'INPUT') {
					inputType = (element as HTMLInputElement).type;
				}

				return {
					tagName,
					isLink,
					isImage,
					isInput,
					isEditable,
					isTextSelected,
					// Long selections are only ever used for a "search for…" label,
					// so there is no reason to ship the whole thing over the wire.
					selectedText: selectedText.slice(0, 200),
					linkUrl: anchor?.href,
					linkText: anchor?.textContent?.trim().slice(0, 120),
					imageUrl: isImage ? (element as HTMLImageElement).src : undefined,
					mediaUrl: mediaElement?.currentSrc || mediaElement?.src,
					mediaType: mediaElement ? mediaElement.tagName.toLowerCase() : undefined,
					inputType,
					pageUrl: location.href
				};
			}, { x: target.x, y: target.y });

			if (!contextData) return null;

			// Build context menu items based on element type
			const items = this.buildContextMenuItems(contextData, navigation);

			const menuId = nanoid(10);
			const menuInfo: any = {
				sessionId, // Internal use only, converted to tabId at previewService layer
				menuId,
				x,
				y,
				// Kept so actions that re-hit-test (paste, media controls) can go
				// straight back to the same element instead of re-resolving.
				frameX: target.x,
				frameY: target.y,
				frameUrl: target.frame.url(),
				items,
				elementInfo: contextData,
				timestamp: Date.now()
			};

			debug.log('preview', `📜 Context menu requested at (${x}, ${y}) for element: ${contextData.tagName}`);
			return menuInfo;
		} catch (error) {
			debug.error('preview', 'Error checking for context menu:', error);
			return null;
		}
	}

	/**
	 * Build context menu items based on element type
	 */
	private buildContextMenuItems(
		elementInfo: {
			isLink?: boolean;
			isImage?: boolean;
			isEditable?: boolean;
			isTextSelected?: boolean;
			selectedText?: string;
			linkUrl?: string;
			imageUrl?: string;
			mediaUrl?: string;
			mediaType?: string;
		},
		navigation?: { canGoBack: boolean; canGoForward: boolean }
	): BrowserContextMenuItem[] {
		const items: BrowserContextMenuItem[] = [];
		let separatorSeq = 0;

		/** Append a divider, but never two in a row and never a leading one. */
		const divider = () => {
			const last = items[items.length - 1];
			if (!last || last.type === 'separator') return;
			separatorSeq += 1;
			items.push({ id: `separator-${separatorSeq}`, label: '', enabled: false, type: 'separator' });
		};

		// Context-specific actions come first, exactly as a browser orders them:
		// what you right-clicked on matters more than what the page can do.
		if (elementInfo.isLink && elementInfo.linkUrl) {
			items.push(
				{ id: 'open-link-new-tab', label: 'Open Link in New Tab', enabled: true, icon: 'lucide:external-link' },
				{ id: 'open-link-host', label: 'Open Link in Your Browser', enabled: true, icon: 'lucide:app-window' },
				{ id: 'copy-link', label: 'Copy Link Address', enabled: true, icon: 'lucide:link' }
			);
			divider();
		}

		if (elementInfo.isImage && elementInfo.imageUrl) {
			items.push(
				{ id: 'open-image-new-tab', label: 'Open Image in New Tab', enabled: true, icon: 'lucide:image' },
				{ id: 'save-image', label: 'Save Image As…', enabled: true, icon: 'lucide:download' },
				{ id: 'copy-image', label: 'Copy Image', enabled: true, icon: 'lucide:copy' },
				{ id: 'copy-image-address', label: 'Copy Image Address', enabled: true, icon: 'lucide:link' }
			);
			divider();
		}

		if (elementInfo.mediaUrl) {
			items.push(
				{ id: 'media-play-pause', label: 'Play / Pause', enabled: true, icon: 'lucide:play' },
				{ id: 'media-mute', label: 'Mute / Unmute', enabled: true, icon: 'lucide:volume-2' },
				{ id: 'media-loop', label: 'Loop', enabled: true, icon: 'lucide:repeat' },
				{
					id: 'open-media-new-tab',
					label: `Open ${elementInfo.mediaType === 'audio' ? 'Audio' : 'Video'} in New Tab`,
					enabled: true,
					icon: 'lucide:external-link'
				}
			);
			divider();
		}

		if (elementInfo.isEditable) {
			items.push(
				{ id: 'undo', label: 'Undo', enabled: true, icon: 'lucide:undo-2' },
				{ id: 'redo', label: 'Redo', enabled: true, icon: 'lucide:redo-2' }
			);
			divider();
			items.push(
				{ id: 'cut', label: 'Cut', enabled: !!elementInfo.isTextSelected, icon: 'lucide:scissors' },
				{ id: 'copy', label: 'Copy', enabled: !!elementInfo.isTextSelected, icon: 'lucide:copy' },
				{ id: 'paste', label: 'Paste', enabled: true, icon: 'lucide:clipboard' },
				{ id: 'paste-plain', label: 'Paste as Plain Text', enabled: true, icon: 'lucide:clipboard-type' },
				{ id: 'delete', label: 'Delete', enabled: !!elementInfo.isTextSelected, icon: 'lucide:eraser' },
				{ id: 'select-all', label: 'Select All', enabled: true, icon: 'lucide:text-select' }
			);
			divider();
		} else if (elementInfo.isTextSelected) {
			const snippet = (elementInfo.selectedText || '').replace(/\s+/g, ' ').trim();
			const label = snippet.length > 24 ? `${snippet.slice(0, 24)}…` : snippet;
			items.push(
				{ id: 'copy', label: 'Copy', enabled: true, icon: 'lucide:copy' },
				{
					id: 'search-selection',
					label: label ? `Search for “${label}”` : 'Search for selection',
					enabled: true,
					icon: 'lucide:search'
				}
			);
			divider();
		}

		// Page-level navigation last, and only enabled where it can actually go
		// somewhere — an always-enabled Back that does nothing is worse than none.
		items.push(
			{ id: 'back', label: 'Back', enabled: navigation?.canGoBack ?? false, icon: 'lucide:arrow-left' },
			{ id: 'forward', label: 'Forward', enabled: navigation?.canGoForward ?? false, icon: 'lucide:arrow-right' },
			{ id: 'reload', label: 'Reload', enabled: true, icon: 'lucide:refresh-cw' }
		);
		divider();

		if (!elementInfo.isEditable) {
			items.push({ id: 'select-all', label: 'Select All', enabled: true, icon: 'lucide:text-select' });
		}
		items.push(
			{ id: 'copy-page-url', label: 'Copy Page Address', enabled: true, icon: 'lucide:link-2' },
			{ id: 'open-page-host', label: 'Open Page in Your Browser', enabled: true, icon: 'lucide:app-window' },
			{ id: 'print', label: 'Print…', enabled: true, icon: 'lucide:printer' }
		);
		divider();
		items.push({ id: 'inspect', label: 'Inspect', enabled: true, icon: 'lucide:code' });

		return items;
	}

	/**
	 * Fetch image from page and emit download event with base64 data
	 */
	private async downloadImageFromPage(page: Page, imageUrl: string): Promise<void> {
		try {
			debug.log('preview', `💾 Fetching image for download: ${imageUrl}`);

			// Fetch image as base64 using page.evaluate
			const imageData = await page.evaluate(async (url) => {
				try {
					const response = await fetch(url);
					const blob = await response.blob();

					return new Promise<{ base64: string, type: string, filename: string }>((resolve, reject) => {
						const reader = new FileReader();
						reader.onloadend = () => {
							const base64 = reader.result as string;
							// Extract filename from URL
							const urlParts = url.split('/');
							let filename = urlParts[urlParts.length - 1].split('?')[0] || 'image';

							// If no extension, add one based on blob type
							if (!filename.includes('.')) {
								const ext = blob.type.split('/')[1] || 'png';
								filename = `image.${ext}`;
							}

							resolve({
								base64: base64.split(',')[1], // Remove data:image/png;base64, prefix
								type: blob.type,
								filename
							});
						};
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
				} catch (error) {
					throw new Error(`Failed to fetch image: ${error}`);
				}
			}, imageUrl);

			// Emit event with image data to frontend
			this.emit('download-image', imageData);
			debug.log('preview', `✅ Image data sent for download: ${imageData.filename}`);
		} catch (error) {
			debug.error('preview', '❌ Failed to fetch image for download:', error);
		}
	}

	/**
	 * Paste text to element at coordinates
	 */
	private async pasteTextToPage(page: Page, x: number, y: number, text: string): Promise<void> {
		try {
			debug.log('preview', `📋 Pasting text to element at (${x}, ${y})`);

			const target = await resolveFrameTarget(page, x, y);

			await target.frame.evaluate((params) => {
				const { x, y, text } = params;
				const element = document.elementFromPoint(x, y) as HTMLElement;

				if (element) {
					// If it's an input element, insert text at cursor position
					if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
						const input = element as HTMLInputElement | HTMLTextAreaElement;
						const start = input.selectionStart || 0;
						const end = input.selectionEnd || 0;
						const currentValue = input.value;

						// Insert text at cursor position
						input.value = currentValue.substring(0, start) + text + currentValue.substring(end);

						// Move cursor to end of inserted text
						const newCursorPos = start + text.length;
						input.setSelectionRange(newCursorPos, newCursorPos);

						// Trigger input event for React/Vue compatibility
						const inputEvent = new Event('input', { bubbles: true });
						input.dispatchEvent(inputEvent);

						// Trigger change event
						const changeEvent = new Event('change', { bubbles: true });
						input.dispatchEvent(changeEvent);
					} else if (element.isContentEditable) {
						// For contenteditable elements
						document.execCommand('insertText', false, text);
					}
				}
			}, { x: target.x, y: target.y, text });

			debug.log('preview', `✅ Pasted ${text.length} characters successfully`);
		} catch (error) {
			debug.error('preview', '❌ Failed to paste text:', error);
		}
	}

	/**
	 * Fetch image from page and emit copy event with base64 data
	 */
	private async copyImageFromPage(page: Page, imageUrl: string): Promise<void> {
		try {
			debug.log('preview', `📋 Fetching image for clipboard: ${imageUrl}`);

			// Fetch image as base64 using page.evaluate
			const imageData = await page.evaluate(async (url) => {
				try {
					const response = await fetch(url);
					const blob = await response.blob();

					return new Promise<{ base64: string, type: string }>((resolve, reject) => {
						const reader = new FileReader();
						reader.onloadend = () => {
							const base64 = reader.result as string;
							resolve({
								base64: base64.split(',')[1], // Remove data:image/png;base64, prefix
								type: blob.type
							});
						};
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					});
				} catch (error) {
					throw new Error(`Failed to fetch image: ${error}`);
				}
			}, imageUrl);

			// Emit event with image data to frontend
			this.emit('copy-image-to-clipboard', imageData);
			debug.log('preview', `✅ Image data sent for clipboard`);
		} catch (error) {
			debug.error('preview', '❌ Failed to fetch image for clipboard:', error);
		}
	}

	/**
	 * Handle context menu action from frontend
	 */
	async handleContextMenuResponse(page: Page, response: BrowserContextMenuResponse, menuInfo: BrowserContextMenuInfo, clipboardText?: string): Promise<boolean> {
		const { itemId } = response;

		try {
			debug.log('preview', `🎯 Executing context menu action: ${itemId}`);

			switch (itemId) {
				case 'back':
					await page.goBack();
					break;

				case 'forward':
					await page.goForward();
					break;

				case 'reload':
					await page.reload();
					break;

				case 'copy':
					// Read the selection out of the page and hand it to the viewer's
					// clipboard: `execCommand('copy')` would only fill the headless
					// browser's, which nothing the user can paste into ever reads.
					{
						const selected = await readSelection(page);
						if (selected) {
							this.emit('copy-to-clipboard', { text: selected });
						}
					}
					break;

				case 'cut':
					{
						const selected = await readSelection(page, true);
						if (selected) {
							this.emit('copy-to-clipboard', { text: selected });
						}
					}
					break;

				case 'paste':
				case 'paste-plain':
					// Paste clipboard content to the page
					if (clipboardText !== undefined) {
						await this.pasteTextToPage(page, menuInfo.x, menuInfo.y, clipboardText);
					} else {
						debug.warn('preview', '⚠️ No clipboard text provided for paste action');
					}
					break;

				case 'undo':
					await page.evaluate(() => document.execCommand('undo'));
					break;

				case 'redo':
					await page.evaluate(() => document.execCommand('redo'));
					break;

				case 'delete':
					await page.evaluate(() => document.execCommand('delete'));
					break;

				case 'select-all': {
					// Inside a field select just that field, otherwise the document —
					// the same split Chrome makes.
					const selectAllTarget = await resolveFrameTarget(page, menuInfo.x, menuInfo.y);
					await selectAllTarget.frame.evaluate(() => {
						const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
						if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
							active.select();
						} else {
							document.execCommand('selectAll');
						}
					});
					break;
				}

				case 'search-selection':
					{
						const selected = await readSelection(page);
						if (selected.trim()) {
							this.emit('open-url-new-tab', {
								url: `https://www.google.com/search?q=${encodeURIComponent(selected.trim())}`
							});
						}
					}
					break;

				case 'copy-page-url':
					this.emit('copy-to-clipboard', { text: page.url() });
					break;

				case 'open-page-host':
					this.emit('open-url-host-browser', { url: page.url() });
					break;

				case 'open-link-host':
					if (menuInfo.elementInfo.linkUrl) {
						this.emit('open-url-host-browser', { url: menuInfo.elementInfo.linkUrl });
					}
					break;

				case 'open-media-new-tab':
					if (menuInfo.elementInfo.mediaUrl) {
						this.emit('open-url-new-tab', { url: menuInfo.elementInfo.mediaUrl });
					}
					break;

				case 'media-play-pause':
				case 'media-mute':
				case 'media-loop': {
					const mediaTarget = await resolveFrameTarget(page, menuInfo.x, menuInfo.y);
					await mediaTarget.frame.evaluate(
						(params: { x: number; y: number; action: string }) => {
							const element = document.elementFromPoint(params.x, params.y);
							const media = (element?.tagName === 'VIDEO' || element?.tagName === 'AUDIO'
								? element
								: element?.closest('video, audio')) as HTMLMediaElement | null;
							if (!media) return;

							if (params.action === 'media-play-pause') {
								if (media.paused) void media.play();
								else media.pause();
							} else if (params.action === 'media-mute') {
								media.muted = !media.muted;
							} else {
								media.loop = !media.loop;
							}
						},
						{ x: mediaTarget.x, y: mediaTarget.y, action: itemId }
					);
					break;
				}

				case 'print':
					this.emit('print-page', { timestamp: Date.now() });
					break;

				case 'inspect':
					this.emit('open-inspector', { timestamp: Date.now() });
					break;

				case 'copy-link':
					if (menuInfo.elementInfo.linkUrl) {
						// Emit event to frontend to copy to clipboard (can't access clipboard from backend)
						this.emit('copy-to-clipboard', { text: menuInfo.elementInfo.linkUrl });
					}
					break;

				case 'copy-image-address':
					if (menuInfo.elementInfo.imageUrl) {
						this.emit('copy-to-clipboard', { text: menuInfo.elementInfo.imageUrl });
					}
					break;

				case 'open-link-new-tab':
					if (menuInfo.elementInfo.linkUrl) {
						this.emit('open-url-new-tab', { url: menuInfo.elementInfo.linkUrl });
					}
					break;

				case 'open-image-new-tab':
					if (menuInfo.elementInfo.imageUrl) {
						this.emit('open-url-new-tab', { url: menuInfo.elementInfo.imageUrl });
					}
					break;

				case 'save-image':
					if (menuInfo.elementInfo.imageUrl) {
						// Fetch image from page and send to frontend
						await this.downloadImageFromPage(page, menuInfo.elementInfo.imageUrl);
					}
					break;

				case 'copy-image':
					if (menuInfo.elementInfo.imageUrl) {
						// Fetch image from page and send to frontend
						await this.copyImageFromPage(page, menuInfo.elementInfo.imageUrl);
					}
					break;

				default:
					debug.warn('preview', `⚠️ Unknown context menu action: ${itemId}`);
					return false;
			}

			return true;
		} catch (error) {
			debug.error('preview', `Error handling context menu action ${itemId}:`, error);
			return false;
		}
	}
}
