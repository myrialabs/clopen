/**
 * Browser Console WebSocket Handler
 * Handles browser console operations (get, clear, execute, toggle)
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { requireBrowserTabAccess } from '../access';

export const consolePreviewHandler = createRouter()
	// Get console logs
	.http('preview:browser-console-get', {
		data: t.Object({}),
		response: t.Object({
			logs: t.Any()
		})
	}, async ({ conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn);
		const consoleLogs = previewService.getConsoleLogs(tab.id);
		return { logs: consoleLogs };
	})

	// Clear console logs
	.http('preview:browser-console-clear', {
		data: t.Object({}),
		response: t.Object({
			message: t.String()
		})
	}, async ({ conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn);

		const success = previewService.clearConsoleLogs(tab.id);

		if (!success) {
			throw new Error('Access denied');
		}

		return { message: 'Console logs cleared' };
	})

	// Execute console command
	.http('preview:browser-console-execute', {
		data: t.Object({
			command: t.String({ minLength: 1 })
		}),
		response: t.Object({
			result: t.Any()
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn);

		const result = await previewService.executeConsoleCommand(tab.id, data.command);
		return { result };
	})

	// Toggle console logging
	.http('preview:browser-console-toggle', {
		data: t.Object({
			enabled: t.Boolean()
		}),
		response: t.Object({
			enabled: t.Boolean(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { previewService, tab } = requireBrowserTabAccess(conn);

		const success = previewService.toggleConsoleLogging(tab.id, data.enabled);

		if (!success) {
			throw new Error('Access denied');
		}

		return {
			enabled: data.enabled,
			message: `Console logging ${data.enabled ? 'enabled' : 'disabled'}`
		};
	});
