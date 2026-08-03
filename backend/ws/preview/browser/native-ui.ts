/**
 * Browser Native UI WebSocket Handler
 * Handles native browser UI interactions: dialogs, print, select dropdown, and context menu
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 *
 * Note: Event forwarding is now handled by BrowserPreviewServiceManager
 * per-project service instances with proper project scoping.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { requireBrowserPreviewAccess, requireBrowserTabAccess } from '../access';

// Event forwarding is now handled automatically by BrowserPreviewServiceManager
// when service instances are created, ensuring proper project isolation.

export const nativeUIPreviewHandler = createRouter()
	/**
	 * Take the page out of full screen on the viewer's behalf.
	 *
	 * The page draws its own exit hint, but it is a DOM node the page is free
	 * to destroy — and a fullscreen Chrome granted from its own C++ leaves no
	 * hint at all, just a collapsed capture surface that reads as a preview
	 * stuck full screen. This route is the way out that the page cannot lose.
	 */
	.http('preview:browser-exit-fullscreen', {
		data: t.Object({
			tabId: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean()
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn, data.tabId);
		const success = await previewService.exitPageFullscreen(tab.id);
		return { success };
	})

	// Action: Client responds to a dialog (alert, confirm, prompt)
	.on('preview:browser-dialog-input', {
		data: t.Object({
			dialogId: t.String({ minLength: 1 }),
			accept: t.Boolean(),
			promptText: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		try {
			const { dialogId, accept, promptText } = data;
			const { projectId, previewService } = requireBrowserPreviewAccess(conn);

			debug.log('preview', `📬 Dialog response received from frontend - dialogId: ${dialogId}, accept: ${accept}${promptText ? `, promptText: "${promptText}"` : ''} (project: ${projectId})`);

			// Get active tab
			const tab = previewService.getActiveTab();
			if (!tab) {
				debug.error('preview', `❌ No active tab for dialog input (project: ${projectId})`);
				return;
			}

			debug.log('preview', `✅ Active tab found: ${tab.id}`);

			// Send response to dialog handler
			const result = await previewService.respondToDialog({
				tabId: tab.id,
				dialogId,
				accept,
				promptText
			});

			if (result) {
				debug.log('preview', `✅ Dialog response processed successfully - dialogId: ${dialogId}`);
			} else {
				debug.warn('preview', `⚠️ Dialog response failed - dialogId: ${dialogId} (dialog may not be found)`);
			}
		} catch (error) {
			debug.error('preview', '💥 Error handling dialog response:', error);
		}
	})

	// Action: Client triggers print (in response to print event or manually)
	.on('preview:browser-print-input', {
		data: t.Object({})
	}, async ({ conn }) => {
		try {
			const { projectId, previewService } = requireBrowserPreviewAccess(conn);

			const tab = previewService.getActiveTab();
			if (!tab) {
				debug.error('preview', `No active tab for print input (project: ${projectId})`);
				return;
			}

			debug.log('preview', `🖨️ Print trigger received for tab: ${tab.id} (project: ${projectId})`);

			// For native print, we just acknowledge the trigger
			// Frontend will handle window.print() directly
		} catch (error) {
			debug.error('preview', 'Error handling print trigger:', error);
		}
	})

	// Action: Client responds to a select dropdown
	.on('preview:browser-select-input', {
		data: t.Object({
			sessionId: t.String({ minLength: 1 }),
			selectId: t.String({ minLength: 1 }),
			selectedIndex: t.Number()
		})
	}, async ({ data, conn }) => {
		try {
			const { sessionId, selectId, selectedIndex } = data;
			const { projectId, previewService } = requireBrowserPreviewAccess(conn);

			debug.log('preview', `📋 Select response received - selectId: ${selectId}, selectedIndex: ${selectedIndex} (project: ${projectId})`);

			// Send response to native UI handler
			await previewService.handleSelectResponse(sessionId, {
				tabId: sessionId,
				selectId,
				selectedIndex
			});
		} catch (error) {
			debug.error('preview', 'Error handling select response:', error);
		}
	})

	// Action: Client responds to a context menu
	.on('preview:browser-context-menu-input', {
		data: t.Object({
			sessionId: t.String({ minLength: 1 }),
			menuId: t.String({ minLength: 1 }),
			itemId: t.String({ minLength: 1 }),
			clipboardText: t.Optional(t.String())
		})
	}, async ({ data, conn }) => {
		try {
			const { sessionId, menuId, itemId, clipboardText } = data;
			const { projectId, previewService } = requireBrowserPreviewAccess(conn);

			debug.log('preview', `📜 Context menu response received - menuId: ${menuId}, itemId: ${itemId} (project: ${projectId})`);

			// Send response to native UI handler
			await previewService.handleContextMenuResponse(sessionId, {
				tabId: sessionId,
				menuId,
				itemId
			}, clipboardText);
		} catch (error) {
			debug.error('preview', 'Error handling context menu response:', error);
		}
	})

	// Event declarations (Server → Client)
	// These events are emitted by preview service when native UI interactions occur
	.emit('preview:browser-dialog', t.Object({
		sessionId: t.String(),
		dialogId: t.String(),
		type: t.Union([
			t.Literal('alert'),
			t.Literal('confirm'),
			t.Literal('prompt'),
			t.Literal('beforeunload')
		]),
		message: t.String(),
		defaultValue: t.Optional(t.String()),
		timestamp: t.Number()
	}))

	/**
	 * The page's dialog has been answered — by whoever got there first.
	 *
	 * A dialog belongs to the page, not to a viewer, but each viewer was shown
	 * its own copy of the prompt. Without this the other devices keep an overlay
	 * for a dialog that no longer exists, and answering it again does nothing.
	 */
	.emit('preview:browser-dialog-closed', t.Object({
		sessionId: t.String(),
		dialogId: t.String(),
		timestamp: t.Number()
	}))

	.emit('preview:browser-print', t.Object({
		sessionId: t.String(),
		timestamp: t.Number()
	}))

	.emit('preview:browser-select', t.Object({
		sessionId: t.String(),
		selectId: t.String(),
		x: t.Number(),
		y: t.Number(),
		boundingBox: t.Object({
			x: t.Number(),
			y: t.Number(),
			width: t.Number(),
			height: t.Number()
		}),
		options: t.Array(t.Object({
			index: t.Number(),
			value: t.String(),
			text: t.String(),
			selected: t.Boolean(),
			disabled: t.Optional(t.Boolean())
		})),
		selectedIndex: t.Number(),
		timestamp: t.Number()
	}))

	.emit('preview:browser-context-menu', t.Object({
		sessionId: t.String(),
		menuId: t.String(),
		x: t.Number(),
		y: t.Number(),
		items: t.Array(t.Object({
			id: t.String(),
			label: t.String(),
			enabled: t.Boolean(),
			type: t.Optional(t.Union([
				t.Literal('normal'),
				t.Literal('separator'),
				t.Literal('submenu')
			])),
			icon: t.Optional(t.String())
		})),
		elementInfo: t.Object({
			tagName: t.String(),
			isLink: t.Boolean(),
			isImage: t.Boolean(),
			isInput: t.Boolean(),
			isEditable: t.Boolean(),
			isTextSelected: t.Boolean(),
			selectedText: t.Optional(t.String()),
			linkUrl: t.Optional(t.String()),
			linkText: t.Optional(t.String()),
			imageUrl: t.Optional(t.String()),
			mediaUrl: t.Optional(t.String()),
			mediaType: t.Optional(t.String()),
			inputType: t.Optional(t.String()),
			pageUrl: t.Optional(t.String())
		}),
		timestamp: t.Number()
	}))

	.emit('preview:browser-copy-to-clipboard', t.Object({
		text: t.String()
	}))

	.emit('preview:browser-open-url-new-tab', t.Object({
		url: t.String()
	}))

	// "Open in Your Browser" — leaves the preview entirely and hands the URL to
	// the viewer's own browser.
	.emit('preview:browser-open-url-host', t.Object({
		url: t.String()
	}))

	// "Inspect" — asks the viewer to reveal the console panel.
	.emit('preview:browser-open-inspector', t.Object({
		timestamp: t.Number()
	}))

	.emit('preview:browser-download-image', t.Object({
		base64: t.String(),
		type: t.String(),
		filename: t.String()
	}))

	.emit('preview:browser-copy-image-to-clipboard', t.Object({
		base64: t.String(),
		type: t.String()
	}));
