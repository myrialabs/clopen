/**
 * Browser Console WebSocket Handler
 * Handles browser console operations (get, clear, execute, toggle)
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export const consolePreviewHandler = createRouter()
	// Get console logs
	.http('preview:browser-console-get', {
		data: t.Object({}),
		response: t.Object({
			logs: t.Any()
		})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const tab = previewService.getActiveTab();
		if (!tab) {
			throw new Error('No active tab');
		}

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
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const tab = previewService.getActiveTab();
		if (!tab) {
			throw new Error('No active tab');
		}

		const success = previewService.clearConsoleLogs(tab.id);

		if (!success) {
			throw new Error('Session not found');
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
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const tab = previewService.getActiveTab();
		if (!tab) {
			throw new Error('No active tab');
		}

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
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const tab = previewService.getActiveTab();
		if (!tab) {
			throw new Error('No active tab');
		}

		const success = previewService.toggleConsoleLogging(tab.id, data.enabled);

		if (!success) {
			throw new Error('Session not found');
		}

		return {
			enabled: data.enabled,
			message: `Console logging ${data.enabled ? 'enabled' : 'disabled'}`
		};
	});
