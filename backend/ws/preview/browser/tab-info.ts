/**
 * Browser Tab Info WebSocket Handler
 * Handles getting browser tab information and listing all tabs
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserPreviewServiceManager } from '../../../lib/preview/index';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export const tabInfoPreviewHandler = createRouter()
	// Get single tab info
	.http('preview:browser-tab-info', {
		data: t.Object({
			tabId: t.Optional(t.String()) // If not provided, get active tab info
		}),
		response: t.Object({
			tabId: t.String(),
			url: t.String(),
			title: t.String(),
			quality: t.String(),
			isStreaming: t.Boolean(),
			deviceSize: t.String(),
			rotation: t.String(),
			isActive: t.Boolean()
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

		const tabInfo = previewService.getTabInfo(tab.id);
		if (!tabInfo) {
			throw new Error('Tab info not found');
		}

		return {
			...tabInfo,
			tabId: tabInfo.id
		};
	})

	// Get all active tabs (for session recovery after browser refresh)
	.http('preview:browser-tabs-list', {
		data: t.Object({}),
		response: t.Object({
			tabs: t.Array(t.Object({
				tabId: t.String(),
				url: t.String(),
				title: t.String(),
				quality: t.String(),
				isStreaming: t.Boolean(),
				deviceSize: t.String(),
				rotation: t.String(),
				isActive: t.Boolean()
			})),
			activeTabId: t.Union([t.String(), t.Null()]),
			count: t.Number()
		})
	}, async ({ conn }) => {
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const allTabsInfo = previewService.getAllTabsInfo();
		const activeTab = previewService.getActiveTab();

		debug.log('preview', `📋 Listing ${allTabsInfo.length} active browser tabs for session recovery (project: ${projectId})`);

		return {
			tabs: allTabsInfo.map(tab => ({
				tabId: tab.id,
				url: tab.url,
				title: tab.title,
				quality: tab.quality,
				isStreaming: tab.isStreaming,
				deviceSize: tab.deviceSize,
				rotation: tab.rotation,
				isActive: tab.isActive
			})),
			activeTabId: activeTab?.id || null,
			count: allTabsInfo.length
		};
	})

	// Switch to a specific tab (for session recovery)
	.http('preview:browser-tab-switch', {
		data: t.Object({
			tabId: t.String()
		}),
		response: t.Object({
			success: t.Boolean(),
			tabId: t.String(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { tabId } = data;
		const projectId = ws.getProjectId(conn);

		// Get project-specific preview service
		const previewService = browserPreviewServiceManager.getService(projectId);

		const success = previewService.switchTab(tabId);
		if (!success) {
			throw new Error(`Failed to switch to tab: ${tabId}`);
		}

		debug.log('preview', `🔄 Switched to tab: ${tabId} (project: ${projectId})`);

		return {
			success: true,
			tabId,
			message: `Switched to tab ${tabId}`
		};
	});
