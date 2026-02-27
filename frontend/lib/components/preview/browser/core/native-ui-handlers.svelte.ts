/**
 * Browser Native UI Handlers
 * Handles native UI events (dialogs, select, context menu, etc.) for BrowserPreview
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';
import type { BrowserDialogEvent, BrowserPrintEvent, BrowserSelectInfo, BrowserContextMenuInfo } from '$frontend/lib/types/native-ui';
import type { TabManager } from './tab-manager.svelte';

export interface NativeUIHandlerConfig {
	tabManager: TabManager;
	transformBrowserToDisplayCoordinates?: (x: number, y: number) => { x: number, y: number } | null;
	onSelectOpen?: (selectInfo: BrowserSelectInfo) => void;
	onContextMenuOpen?: (menuInfo: BrowserContextMenuInfo) => void;
	onCopyToClipboard?: (text: string) => void;
	onOpenUrlNewTab?: (url: string) => void;
	onDownloadImage?: (base64: string, type: string, filename: string) => void;
	onCopyImageToClipboard?: (base64: string, type: string) => void;
}

/**
 * Create native UI event handler
 */
export function createNativeUIHandler(config: NativeUIHandlerConfig) {
	const {
		tabManager,
		transformBrowserToDisplayCoordinates,
		onSelectOpen,
		onContextMenuOpen,
		onCopyToClipboard,
		onOpenUrlNewTab,
		onDownloadImage,
		onCopyImageToClipboard
	} = config;

	/**
	 * Setup WebSocket event listeners for native UI events
	 */
	function setupEventListeners() {
		// Listen to dialog events
		ws.on('preview:browser-dialog', handleDialogEvent);

		// Listen to print events
		ws.on('preview:browser-print', handlePrintEvent);

		// Listen to select events
		ws.on('preview:browser-select', handleSelectEvent);

		// Listen to context menu events
		ws.on('preview:browser-context-menu', handleContextMenuEvent);

		// Listen to clipboard copy events
		ws.on('preview:browser-copy-to-clipboard', handleCopyToClipboard);

		// Listen to open URL events
		ws.on('preview:browser-open-url-new-tab', handleOpenUrlNewTab);

		// Listen to download image events
		ws.on('preview:browser-download-image', handleDownloadImage);

		// Listen to copy image to clipboard events
		ws.on('preview:browser-copy-image-to-clipboard', handleCopyImageToClipboard);
	}

	/**
	 * Handle dialog events (alert, confirm, prompt)
	 */
	async function handleDialogEvent(data: BrowserDialogEvent) {
		debug.log('preview', `🎭 Dialog event received: ${data.type} - ${data.message} (dialogId: ${data.dialogId})`);

		let response: boolean | null = null;
		let promptText: string | undefined = undefined;

		// Show native browser dialog based on type
		switch (data.type) {
			case 'alert':
				window.alert(data.message);
				response = true; // Alert always accepts
				break;

			case 'confirm':
				response = window.confirm(data.message);
				break;

			case 'prompt':
				const result = window.prompt(data.message, data.defaultValue || '');
				if (result !== null) {
					response = true;
					promptText = result;
				} else {
					response = false;
				}
				break;

			case 'beforeunload':
				response = window.confirm(data.message);
				break;
		}

		// Send response back to backend
		if (response !== null) {
			debug.log('preview', `📤 Sending dialog response - dialogId: ${data.dialogId}, accept: ${response}${promptText ? `, promptText: "${promptText}"` : ''}`);

			ws.emit('preview:browser-dialog-input', {
				dialogId: data.dialogId,
				accept: response,
				promptText
			});

			debug.log('preview', `✅ Dialog response sent successfully`);
		} else {
			debug.warn('preview', `⚠️ No response to send for dialog: ${data.dialogId}`);
		}
	}

	/**
	 * Handle print events
	 */
	async function handlePrintEvent(data: BrowserPrintEvent) {
		debug.log('preview', `🖨️ Print event received for session: ${data.sessionId}`);
		window.print();
	}

	/**
	 * Handle select dropdown events
	 */
	function handleSelectEvent(data: BrowserSelectInfo) {
		debug.log('preview', `📋 Select event received at (${data.x}, ${data.y}) with ${data.options.length} options for session ${data.sessionId}`);

		// Check if this is for the active tab
		const activeTab = tabManager.activeTab;
		if (!activeTab) {
			debug.warn('preview', `Select event ignored - no active tab`);
			return;
		}

		if (activeTab.sessionId !== data.sessionId) {
			debug.warn('preview', `Select event ignored - session mismatch (active: ${activeTab.sessionId}, event: ${data.sessionId})`);
			return;
		}

		if (!transformBrowserToDisplayCoordinates) {
			debug.error('preview', 'transformBrowserToDisplayCoordinates not available');
			return;
		}

		// Transform coordinates from browser (Puppeteer) to display coordinates
		// The transformation function will handle cases where canvas is not ready (returns null)
		const topLeft = transformBrowserToDisplayCoordinates(data.boundingBox.x, data.boundingBox.y);
		const bottomRight = transformBrowserToDisplayCoordinates(
			data.boundingBox.x + data.boundingBox.width,
			data.boundingBox.y + data.boundingBox.height
		);

		if (!topLeft || !bottomRight) {
			debug.warn('preview', `Select dropdown skipped - coordinate transformation failed (${data.boundingBox.x}, ${data.boundingBox.y})`);
			return;
		}

		// Create transformed select info with display coordinates
		const transformedSelectInfo: BrowserSelectInfo = {
			...data,
			boundingBox: {
				x: topLeft.x,
				y: topLeft.y,
				width: bottomRight.x - topLeft.x,
				height: bottomRight.y - topLeft.y
			}
		};

		debug.log('preview', `📋 Transformed select position: (${transformedSelectInfo.boundingBox.x}, ${transformedSelectInfo.boundingBox.y})`);

		// Show select dropdown overlay
		if (onSelectOpen) {
			onSelectOpen(transformedSelectInfo);
		}
	}

	/**
	 * Handle select option selection
	 */
	function respondSelectOption(selectInfo: BrowserSelectInfo, selectedIndex: number) {
		debug.log('preview', `📋 Select option selected: ${selectedIndex}`);

		ws.emit('preview:browser-select-input', {
			sessionId: selectInfo.sessionId,
			selectId: selectInfo.selectId,
			selectedIndex
		});
	}

	/**
	 * Handle context menu events
	 */
	function handleContextMenuEvent(data: BrowserContextMenuInfo) {
		debug.log('preview', `📜 Context menu event received at (${data.x}, ${data.y}) for session ${data.sessionId}`);

		// Check if this is for the active tab
		const activeTab = tabManager.activeTab;
		if (!activeTab) {
			debug.warn('preview', `Context menu event ignored - no active tab`);
			return;
		}

		if (activeTab.sessionId !== data.sessionId) {
			debug.warn('preview', `Context menu event ignored - session mismatch (active: ${activeTab.sessionId}, event: ${data.sessionId})`);
			return;
		}

		if (!transformBrowserToDisplayCoordinates) {
			debug.error('preview', 'transformBrowserToDisplayCoordinates not available');
			return;
		}

		// Transform coordinates from browser (Puppeteer) to display coordinates
		// The transformation function will handle cases where canvas is not ready (returns null)
		const position = transformBrowserToDisplayCoordinates(data.x, data.y);

		if (!position) {
			debug.warn('preview', `Context menu skipped - coordinate transformation failed (${data.x}, ${data.y})`);
			return;
		}

		// Create transformed context menu info with display coordinates
		const transformedMenuInfo: BrowserContextMenuInfo = {
			...data,
			x: position.x,
			y: position.y
		};

		debug.log('preview', `📜 Transformed context menu position: (${transformedMenuInfo.x}, ${transformedMenuInfo.y})`);

		// Show context menu overlay
		if (onContextMenuOpen) {
			onContextMenuOpen(transformedMenuInfo);
		}
	}

	/**
	 * Handle context menu item selection
	 */
	async function respondContextMenuItem(menuInfo: BrowserContextMenuInfo, itemId: string) {
		debug.log('preview', `📜 Context menu item selected: ${itemId}`);

		// For paste action, read clipboard first
		let clipboardText: string | undefined = undefined;
		if (itemId === 'paste') {
			try {
				if (navigator.clipboard && navigator.clipboard.readText) {
					clipboardText = await navigator.clipboard.readText();
					debug.log('preview', `📋 Clipboard text read: ${clipboardText.length} characters`);
				} else {
					debug.warn('preview', '⚠️ Clipboard API not available');
				}
			} catch (error) {
				debug.error('preview', '❌ Failed to read clipboard:', error);
				// Continue without clipboard text - backend will show warning
			}
		}

		// Send selection back to backend
		ws.emit('preview:browser-context-menu-input', {
			sessionId: menuInfo.sessionId,
			menuId: menuInfo.menuId,
			itemId,
			clipboardText
		});
	}

	/**
	 * Handle copy to clipboard
	 */
	function handleCopyToClipboard(data: { text: string }) {
		debug.log('preview', `📋 Copy to clipboard: ${data.text}`);

		// Copy to clipboard
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(data.text).then(() => {
				debug.log('preview', '✅ Copied to clipboard');
			}).catch((error) => {
				debug.error('preview', '❌ Failed to copy to clipboard:', error);
			});
		}

		if (onCopyToClipboard) {
			onCopyToClipboard(data.text);
		}
	}

	/**
	 * Handle open URL in new tab
	 */
	function handleOpenUrlNewTab(data: { url: string }) {
		debug.log('preview', `🔗 Open URL in new tab: ${data.url}`);

		if (onOpenUrlNewTab) {
			onOpenUrlNewTab(data.url);
		}
	}

	/**
	 * Handle download image
	 */
	async function handleDownloadImage(data: { base64: string; type: string; filename: string }) {
		debug.log('preview', `💾 Download image: ${data.filename}`);

		try {
			// Convert base64 to blob using Data URL
			const res = await fetch(`data:${data.type};base64,${data.base64}`);
			const blob = await res.blob();

			// Ask user for filename (works in all browsers)
			const userFilename = window.prompt('Save image as:', data.filename);

			// User cancelled
			if (userFilename === null) {
				debug.log('preview', '⚠️ Save cancelled by user');
				return;
			}

			// Use provided filename or original if empty
			const finalFilename = userFilename.trim() || data.filename;

			// Trigger download
			const objectUrl = URL.createObjectURL(blob);
			const link = document.createElement('a');
			link.href = objectUrl;
			link.download = finalFilename;
			document.body.appendChild(link);
			link.click();
			document.body.removeChild(link);
			URL.revokeObjectURL(objectUrl);

			debug.log('preview', `✅ Image downloaded: ${finalFilename}`);
		} catch (error) {
			debug.error('preview', '❌ Failed to download image:', error);
		}

		if (onDownloadImage) {
			onDownloadImage(data.base64, data.type, data.filename);
		}
	}

	/**
	 * Handle copy image to clipboard
	 */
	async function handleCopyImageToClipboard(data: { base64: string; type: string }) {
		debug.log('preview', `📋 Copy image to clipboard`);

		try {
			// Convert base64 to blob using Data URL
			const res = await fetch(`data:${data.type};base64,${data.base64}`);
			const blob = await res.blob();

			// Copy to clipboard using Clipboard API
			if (navigator.clipboard && navigator.clipboard.write) {
				await navigator.clipboard.write([
					new ClipboardItem({
						[data.type]: blob
					})
				]);
				debug.log('preview', '✅ Image copied to clipboard');
			} else {
				debug.error('preview', '❌ Clipboard API not supported');
			}
		} catch (error) {
			debug.error('preview', '❌ Failed to copy image to clipboard:', error);
		}

		if (onCopyImageToClipboard) {
			onCopyImageToClipboard(data.base64, data.type);
		}
	}

	return {
		setupEventListeners,
		handleDialogEvent,
		handlePrintEvent,
		handleSelectEvent,
		respondSelectOption,
		handleContextMenuEvent,
		respondContextMenuItem,
		handleCopyToClipboard,
		handleOpenUrlNewTab,
		handleDownloadImage,
		handleCopyImageToClipboard
	};
}

export type NativeUIHandler = ReturnType<typeof createNativeUIHandler>;
