/**
 * Browser Tab Info WebSocket Handler
 * Handles getting browser tab information and listing all tabs
 * **PROJECT ISOLATION**: Uses project-specific BrowserPreviewService instances
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { browserMcpControl } from '../../../preview/browser/browser-mcp-control';
import { debug } from '$shared/utils/logger';
import { requireBrowserPreviewAccess, requireBrowserPreviewAccessFor, requireBrowserTabAccess } from '../access';

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
		const { previewService, tab } = requireBrowserTabAccess(conn, tabId);

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
		data: t.Object({
			// Explicit project target for switch-time recovery (see access helper).
			projectId: t.Optional(t.String())
		}),
		response: t.Object({
			tabs: t.Array(t.Object({
				tabId: t.String(),
				url: t.String(),
				title: t.String(),
				quality: t.String(),
				isStreaming: t.Boolean(),
				deviceSize: t.String(),
				rotation: t.String(),
				isActive: t.Boolean(),
				isMcpControlled: t.Boolean()
			})),
			activeTabId: t.Union([t.String(), t.Null()]),
			count: t.Number()
		})
	}, async ({ data, conn }) => {
		const { projectId, previewService } = data.projectId
			? requireBrowserPreviewAccessFor(conn, data.projectId)
			: requireBrowserPreviewAccess(conn);

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
				isActive: tab.isActive,
				isMcpControlled: browserMcpControl.isTabControlled(tab.id, projectId)
			})),
			activeTabId: activeTab?.id || null,
			count: allTabsInfo.length
		};
	})

	// Switch to a specific tab (for session recovery)
	.http('preview:browser-tab-switch', {
		data: t.Object({
			tabId: t.String(),
			// Explicit project target for switch-time recovery (see access helper).
			projectId: t.Optional(t.String())
		}),
		response: t.Object({
			success: t.Boolean(),
			tabId: t.String(),
			message: t.String()
		})
	}, async ({ data, conn }) => {
		const { tabId } = data;
		const { projectId, previewService } = data.projectId
			? requireBrowserPreviewAccessFor(conn, data.projectId)
			: requireBrowserPreviewAccess(conn);

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
