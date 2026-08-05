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
				/** Whether an agent is acting on this tab right now. */
				isMcpFocused: t.Boolean(),
				/**
				 * What the agent is doing on this tab, for the caption beside its
				 * cursor. Recovered with the lock: a run holds a tab for minutes,
				 * so a panel opened in the middle of one must not have to wait for
				 * the next action before it can say anything.
				 */
				mcpActivity: t.Optional(t.String()),
				/**
				 * Where the agent's pointer stands, in page coordinates.
				 *
				 * Same reasoning as `mcpActivity`, and the same failure without
				 * it: the pointer only emits while it is moving, so a viewer
				 * arriving between two actions — a reload, a project switch, a
				 * colleague opening the panel mid-run — had a lock and a caption
				 * but no idea where on the page any of it was happening.
				 */
				mcpCursor: t.Optional(t.Object({
					x: t.Number(),
					y: t.Number()
				}))
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
				isMcpFocused: browserMcpControl.isTabFocused(tab.id),
				mcpActivity: browserMcpControl.getActivity(tab.id) ?? undefined,
				mcpCursor: previewService.getMcpCursorPosition(tab.id) ?? undefined
			})),
			activeTabId: activeTab?.id || null,
			count: allTabsInfo.length
		};
	})

	/**
	 * "I am now looking at this tab."
	 *
	 * Deliberately does *not* make the tab the project's active one. Streaming
	 * is attached per (tab, viewer) already, so nothing here needs a shared
	 * notion of "the" tab — and making it shared is what let two people in one
	 * project fight: whoever clicked a tab last moved everyone else's target,
	 * including where their clicks landed. The agent still sets the active tab,
	 * because for the agent it means something.
	 */
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

		if (!previewService.noteTabViewed(tabId)) {
			throw new Error(`Failed to switch to tab: ${tabId}`);
		}

		debug.log('preview', `👁️ Viewer is now watching tab: ${tabId} (project: ${projectId})`);

		return {
			success: true,
			tabId,
			message: `Now viewing tab ${tabId}`
		};
	});
