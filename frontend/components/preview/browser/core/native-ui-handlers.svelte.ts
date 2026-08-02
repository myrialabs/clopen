/**
 * Browser Native UI Handlers
 * Handles native UI events (dialogs, select, context menu, etc.) for BrowserPreview
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import type {
	BrowserConsoleMessage,
	BrowserDialogEvent,
	BrowserPrintEvent,
	BrowserSelectInfo,
	BrowserContextMenuInfo,
	BrowserNativePickerInfo
} from '$frontend/utils/native-ui';
import type { TabManager } from './tab-manager.svelte';

export interface NativeUIHandlerConfig {
	tabManager: TabManager;
	transformBrowserToDisplayCoordinates?: (x: number, y: number) => { x: number, y: number } | null;
	onSelectOpen?: (selectInfo: BrowserSelectInfo) => void;
	onContextMenuOpen?: (menuInfo: BrowserContextMenuInfo) => void;
	onNativePickerOpen?: (picker: BrowserNativePickerInfo) => void;
	onDialogOpen?: (dialog: BrowserDialogEvent) => void;
	/** A dialog is settled — answered here, answered elsewhere, or expired. */
	onDialogClose?: (closed?: { sessionId: string; dialogId: string }) => void;
	onCopyToClipboard?: (text: string) => void;
	onOpenUrlNewTab?: (url: string) => void;
	onOpenUrlInHostBrowser?: (url: string) => void;
	onOpenInspector?: () => void;
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
		onNativePickerOpen,
		onDialogOpen,
		onDialogClose,
		onCopyToClipboard,
		onOpenUrlNewTab,
		onOpenUrlInHostBrowser,
		onOpenInspector,
		onDownloadImage,
		onCopyImageToClipboard
	} = config;

	/**
	 * Setup WebSocket event listeners for native UI events.
	 * Returns a teardown that removes every listener — the coordinator calls it
	 * on unmount so listeners don't accumulate across BrowserPreview re-mounts.
	 */
	function setupEventListeners(): () => void {
		const unsubscribers = [
			ws.on('preview:browser-dialog', handleDialogEvent),
			ws.on('preview:browser-dialog-closed', handleDialogClosed),
			ws.on('preview:browser-print', handlePrintEvent),
			ws.on('preview:browser-select', handleSelectEvent),
			ws.on('preview:browser-context-menu', handleContextMenuEvent),
			ws.on('preview:browser-native-picker' as any, handleNativePickerEvent),
			ws.on('preview:browser-copy-to-clipboard', handleCopyToClipboard),
			ws.on('preview:browser-open-url-new-tab', handleOpenUrlNewTab),
			ws.on('preview:browser-open-url-host' as any, (data: { url: string }) => {
				onOpenUrlInHostBrowser?.(data.url);
			}),
			ws.on('preview:browser-open-inspector' as any, () => {
				onOpenInspector?.();
			}),
			ws.on('preview:browser-console-message' as any, handleConsoleMessage),
			ws.on('preview:browser-console-clear' as any, handleConsoleClear),
			ws.on('preview:browser-download-image', handleDownloadImage),
			ws.on('preview:browser-copy-image-to-clipboard', handleCopyImageToClipboard)
		];

		return () => {
			for (const unsub of unsubscribers) unsub();
		};
	}

	/**
	 * Surface alert/confirm/prompt for the viewer to answer.
	 *
	 * Deliberately not `window.alert` and friends: those block Clopen's own main
	 * thread, which stalls the WebCodecs decoder and freezes the preview behind
	 * the dialog. The overlay renders the same choice without stopping the app.
	 */
	function handleDialogEvent(data: BrowserDialogEvent) {
		debug.log('preview', `🎭 Dialog event received: ${data.type} - ${data.message} (dialogId: ${data.dialogId})`);

		// Handed over with its owning tab attached. A dialog raised by a background
		// tab is held until the user goes back to it rather than being answered on
		// their behalf — and never shown over a different tab's page.
		onDialogOpen?.(data);
	}

	/**
	 * The page's dialog is gone.
	 *
	 * A dialog belongs to the page, so answering it on one device answers it for
	 * everyone — the other viewers were only ever holding a copy of the prompt,
	 * and this is what takes theirs down. Also covers the backend's own
	 * auto-dismiss, which no viewer initiated at all.
	 */
	function handleDialogClosed(data: { sessionId: string; dialogId: string }) {
		onDialogClose?.({ sessionId: data.sessionId, dialogId: data.dialogId });
	}

	/**
	 * Answer the dialog the viewer just resolved.
	 */
	function respondToDialog(dialog: BrowserDialogEvent, accept: boolean, promptText?: string) {
		debug.log('preview', `📤 Dialog response - dialogId: ${dialog.dialogId}, accept: ${accept}`);

		ws.emit('preview:browser-dialog-input', {
			dialogId: dialog.dialogId,
			accept,
			promptText
		});

		// Locally too, so the overlay goes on the click rather than on the
		// round-trip; the broadcast covers every other viewer.
		onDialogClose?.({ sessionId: dialog.sessionId, dialogId: dialog.dialogId });
	}

	/**
	 * Append a console message to its own tab, so switching tabs shows that
	 * tab's history rather than a merged stream.
	 */
	function handleConsoleMessage(data: { sessionId: string; message: BrowserConsoleMessage }) {
		const tab = tabManager.tabs.find((entry) => entry.sessionId === data.sessionId);
		if (!tab) return;

		const existing = tab.consoleLogs ?? [];

		// The backend collapses repeats by mutating the last message and
		// re-emitting it, so a matching id is an update, not a new line.
		const index = existing.findIndex((entry) => entry.id === data.message.id);
		const next =
			index >= 0
				? existing.map((entry, i) => (i === index ? data.message : entry))
				: [...existing, data.message];

		// Mirrors the backend's own ring buffer; without a cap a long-running page
		// grows this array without bound.
		tabManager.updateTab(tab.id, { consoleLogs: next.length > 1000 ? next.slice(-500) : next });
	}

	function handleConsoleClear(data: { sessionId: string }) {
		const tab = tabManager.tabs.find((entry) => entry.sessionId === data.sessionId);
		if (tab) tabManager.updateTab(tab.id, { consoleLogs: [] });
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
	 * Position a colour/date picker over the input that opened it.
	 */
	function handleNativePickerEvent(data: BrowserNativePickerInfo) {
		const activeTab = tabManager.activeTab;
		if (!activeTab || activeTab.sessionId !== data.sessionId) return;

		if (!transformBrowserToDisplayCoordinates) return;

		const topLeft = transformBrowserToDisplayCoordinates(data.boundingBox.x, data.boundingBox.y);
		const bottomRight = transformBrowserToDisplayCoordinates(
			data.boundingBox.x + data.boundingBox.width,
			data.boundingBox.y + data.boundingBox.height
		);
		if (!topLeft || !bottomRight) return;

		onNativePickerOpen?.({
			...data,
			boundingBox: {
				x: topLeft.x,
				y: topLeft.y,
				width: bottomRight.x - topLeft.x,
				height: bottomRight.y - topLeft.y
			}
		});
	}

	/**
	 * Write a picked colour or date back into the page.
	 */
	function respondNativePicker(picker: BrowserNativePickerInfo, value: string) {
		ws.emit('preview:browser-native-picker-input', {
			tabId: picker.sessionId,
			pickerId: picker.pickerId,
			value
		});
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
		respondToDialog,
		handlePrintEvent,
		handleSelectEvent,
		respondSelectOption,
		handleContextMenuEvent,
		respondContextMenuItem,
		handleNativePickerEvent,
		respondNativePicker,
		handleCopyToClipboard,
		handleOpenUrlNewTab,
		handleDownloadImage,
		handleCopyImageToClipboard
	};
}

export type NativeUIHandler = ReturnType<typeof createNativeUIHandler>;
