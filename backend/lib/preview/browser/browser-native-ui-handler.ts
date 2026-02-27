import { EventEmitter } from 'events';
import type { Page } from 'puppeteer';
import type {
	BrowserTab,
	BrowserSelectInfo,
	BrowserSelectResponse,
	BrowserContextMenuInfo,
	BrowserContextMenuResponse,
	BrowserContextMenuItem
} from './types';
import { debug } from '$shared/utils/logger';
import { nanoid } from 'nanoid';

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

			const selectData = await page.evaluate((params) => {
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

				// IMPORTANT: Mark this select element with unique ID for later reference
				selectElement.setAttribute('data-puppeteer-select-id', selectId);

				// Extract select options
				const options = Array.from(selectElement.options).map((opt, index) => ({
					index,
					value: opt.value || '',
					text: opt.textContent || '',
					selected: opt.selected,
					disabled: opt.disabled
				}));

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
			}, { x, y, selectId });

			if (!selectData) return null;
			const selectInfo: any = {
				sessionId, // Internal use only, converted to tabId at previewService layer
				selectId,
				x,
				y,
				boundingBox: selectData.boundingBox,
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
	 * Handle select option selection from frontend
	 */
	async handleSelectResponse(page: Page, response: BrowserSelectResponse): Promise<boolean> {
		const { selectId, selectedIndex } = response;

		try {
			// Update the select value in the page
			const result = await page.evaluate((params) => {
				const { selectId, index } = params;

				// Find the select element by the unique ID we set earlier
				const selectElement = document.querySelector(`select[data-puppeteer-select-id="${selectId}"]`) as HTMLSelectElement;

				if (!selectElement) {
					console.error(`Select element with ID ${selectId} not found`);
					return false;
				}

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
			} else {
				debug.warn('preview', `⚠️ Failed to update select option to index: ${selectedIndex}`);
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
	async checkForContextMenu(sessionId: string, page: Page, x: number, y: number): Promise<BrowserContextMenuInfo | null> {
		try {
			const contextData = await page.evaluate((coordinates) => {
				const { x, y } = coordinates;
				const element = document.elementFromPoint(x, y);

				if (!element) return null;

				// Get element information
				const tagName = element.tagName;
				const isLink = element.tagName === 'A' || element.closest('a') !== null;
				const isImage = element.tagName === 'IMG';
				const isInput = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';

				// Check for text selection
				const selection = window.getSelection();
				const isTextSelected = selection ? selection.toString().length > 0 : false;

				// Get link URL if it's a link
				let linkUrl: string | undefined;
				if (isLink) {
					const linkElement = element.tagName === 'A' ? element as HTMLAnchorElement : element.closest('a') as HTMLAnchorElement;
					linkUrl = linkElement?.href;
				}

				// Get image URL if it's an image
				let imageUrl: string | undefined;
				if (isImage) {
					imageUrl = (element as HTMLImageElement).src;
				}

				// Get input type
				let inputType: string | undefined;
				if (isInput && element.tagName === 'INPUT') {
					inputType = (element as HTMLInputElement).type;
				}

				return {
					tagName,
					isLink,
					isImage,
					isInput,
					isTextSelected,
					linkUrl,
					imageUrl,
					inputType
				};
			}, { x, y });

			if (!contextData) return null;

			// Build context menu items based on element type
			const items = this.buildContextMenuItems(contextData);

			const menuId = nanoid(10);
			const menuInfo: any = {
				sessionId, // Internal use only, converted to tabId at previewService layer
				menuId,
				x,
				y,
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
	private buildContextMenuItems(elementInfo: any): BrowserContextMenuItem[] {
		const items: BrowserContextMenuItem[] = [];

		// Back / Forward
		items.push(
			{ id: 'back', label: 'Back', enabled: true },
			{ id: 'forward', label: 'Forward', enabled: true },
			{ id: 'reload', label: 'Reload', enabled: true },
			{ id: 'separator-1', label: '', enabled: false, type: 'separator' }
		);

		// Link-specific actions
		if (elementInfo.isLink && elementInfo.linkUrl) {
			items.push(
				{ id: 'open-link-new-tab', label: 'Open Link in New Tab', enabled: true },
				{ id: 'copy-link', label: 'Copy Link Address', enabled: true },
				{ id: 'separator-2', label: '', enabled: false, type: 'separator' }
			);
		}

		// Image-specific actions
		if (elementInfo.isImage && elementInfo.imageUrl) {
			items.push(
				{ id: 'open-image-new-tab', label: 'Open Image in New Tab', enabled: true },
				{ id: 'save-image', label: 'Save Image As...', enabled: true },
				{ id: 'copy-image', label: 'Copy Image', enabled: true },
				{ id: 'copy-image-address', label: 'Copy Image Address', enabled: true },
				{ id: 'separator-3', label: '', enabled: false, type: 'separator' }
			);
		}

		// Text selection actions
		if (elementInfo.isTextSelected) {
			items.push(
				{ id: 'copy', label: 'Copy', enabled: true },
				{ id: 'separator-4', label: '', enabled: false, type: 'separator' }
			);
		}

		// Input-specific actions
		if (elementInfo.isInput) {
			items.push(
				{ id: 'cut', label: 'Cut', enabled: true },
				{ id: 'copy', label: 'Copy', enabled: elementInfo.isTextSelected },
				{ id: 'paste', label: 'Paste', enabled: true },
				{ id: 'separator-5', label: '', enabled: false, type: 'separator' }
			);
		}

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

			await page.evaluate((params) => {
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
			}, { x, y, text });

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
					await page.evaluate(() => {
						document.execCommand('copy');
					});
					break;

				case 'cut':
					await page.evaluate(() => {
						document.execCommand('cut');
					});
					break;

				case 'paste':
					// Paste clipboard content to the page
					if (clipboardText !== undefined) {
						await this.pasteTextToPage(page, menuInfo.x, menuInfo.y, clipboardText);
					} else {
						debug.warn('preview', '⚠️ No clipboard text provided for paste action');
					}
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
