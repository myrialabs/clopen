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
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';

// Event forwarding is now handled automatically by BrowserPreviewServiceManager
// when service instances are created, ensuring proper project isolation.

export const nativeUIPreviewHandler = createRouter()
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
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

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
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

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
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

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
			const projectId = ws.getProjectId(conn);

			// Get project-specific preview service
			const previewService = browserPreviewServiceManager.getService(projectId);

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
			isTextSelected: t.Boolean(),
			linkUrl: t.Optional(t.String()),
			imageUrl: t.Optional(t.String()),
			inputType: t.Optional(t.String())
		}),
		timestamp: t.Number()
	}))

	.emit('preview:browser-copy-to-clipboard', t.Object({
		text: t.String()
	}))

	.emit('preview:browser-open-url-new-tab', t.Object({
		url: t.String()
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
