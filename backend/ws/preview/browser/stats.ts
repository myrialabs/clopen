/**
 * Browser Streaming Statistics WebSocket Handler
 * Handles getting browser streaming statistics
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';

export const statsPreviewHandler = createRouter()
	.http('preview:browser-tab-stats', {
		data: t.Object({
			tabId: t.Optional(t.String()) // If not provided, get active tab stats
		}),
		response: t.Object({
			tabId: t.String(),
			isWebCodecsActive: t.Boolean(),
			streamingMode: t.String(),
			stats: t.Union([
				t.Object({
					videoBytesSent: t.Number(),
					audioBytesSent: t.Number(),
					videoFramesEncoded: t.Number(),
					audioFramesEncoded: t.Number(),
					connectionState: t.String()
				}),
				t.Null()
			]),
			timestamp: t.String()
		})
	}, async ({ data, conn }) => {
		const { tabId } = data;
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		// Get tab (active tab if not specified)
		const tab = tabId ? previewService.getTab(tabId) : previewService.getActiveTab();
		if (!tab) {
			throw new Error(tabId ? `Tab not found: ${tabId}` : 'No active tab');
		}

		const stats = await previewService.getWebCodecsStats(tab.id);

		return {
			tabId: tab.id,
			isWebCodecsActive: previewService.isWebCodecsActive(tab.id),
			streamingMode: 'webcodecs',
			stats: stats ?? null,
			timestamp: new Date().toISOString()
		};
	});
