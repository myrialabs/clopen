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
			favicon: t.Optional(t.String()),
			quality: t.String(),
			isStreaming: t.Boolean(),
			deviceSize: t.String(),
			rotation: t.String(),
			isActive: t.Boolean(),
			canGoBack: t.Boolean(),
			canGoForward: t.Boolean()
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
				favicon: t.Optional(t.String()),
				quality: t.String(),
				isStreaming: t.Boolean(),
				deviceSize: t.String(),
				rotation: t.String(),
				isActive: t.Boolean(),
				canGoBack: t.Boolean(),
				canGoForward: t.Boolean(),
				isMcpControlled: t.Boolean(),
				/** The tab this project's agent is acting on right now. */
				isMcpFocused: t.Boolean(),
				/**
				 * What the agent is doing on this tab, for the caption beside its
				 * cursor. Recovered with the lock: a run holds a tab for minutes,
				 * so a panel opened in the middle of one must not have to wait for
				 * the next action before it can say anything.
				 */
				mcpActivity: t.Optional(t.String())
			})),
			activeTabId: t.Union([t.String(), t.Null()]),
			count: t.Number()
		})
	}, async ({ data, conn }) => {
		const { projectId, previewService } = data.projectId
			? requireBrowserPreviewAccessFor(conn, data.projectId)
			: requireBrowserPreviewAccess(conn);

		// This is where the frontend rebuilds its lock state from scratch — a
		// project switch, a page reload — so it is the natural point to collect
		// locks whose chat session died without reaching a release path. Without
		// it, a stuck lock would survive every reload until the server restarted.
		browserMcpControl.releaseOrphans();

		const allTabsInfo = previewService.getAllTabsInfo();
		const activeTab = previewService.getActiveTab();
		const focusedTabId = browserMcpControl.getFocusedTab(projectId);

		debug.log('preview', `📋 Listing ${allTabsInfo.length} active browser tabs for session recovery (project: ${projectId})`);

		return {
			tabs: allTabsInfo.map(tab => ({
				tabId: tab.id,
				url: tab.url,
				title: tab.title,
				favicon: tab.favicon,
				quality: tab.quality,
				isStreaming: tab.isStreaming,
				deviceSize: tab.deviceSize,
				rotation: tab.rotation,
				isActive: tab.isActive,
				canGoBack: tab.canGoBack,
				canGoForward: tab.canGoForward,
				isMcpControlled: browserMcpControl.isTabControlled(tab.id, projectId),
				isMcpFocused: tab.id === focusedTabId,
				mcpActivity: browserMcpControl.getActivity(tab.id) ?? undefined
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
