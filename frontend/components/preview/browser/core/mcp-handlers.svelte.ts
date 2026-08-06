/**
 * Browser MCP Event Handlers
 * Handles MCP (Model Context Protocol) control events for BrowserPreview
 *
 * Supports multi-tab control: each chat session can control multiple tabs.
 * Tracks controlled tabs via a Set of backend tab IDs (session IDs).
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import {
	getMcpControlledBackendIds,
	isBackendTabMcpFocused
} from '$frontend/stores/features/preview-tabs-workspace.svelte';
import type { TabManager } from './tab-manager.svelte';

export interface McpHandlerConfig {
	tabManager: TabManager;
	onLaunchRequest?: (url: string, deviceSize: string, rotation: string, sessionId?: string) => void;
}

/**
 * Create MCP event handler
 */
export function createMcpHandler(config: McpHandlerConfig) {
	const { tabManager, onLaunchRequest } = config;

	// Controlled tabs are owned by the always-on dock sync (single source of
	// truth); read that shared set so the badge/lock stays correct even when this
	// panel wasn't mounted at the moment control started/ended.
	const controlledSessionIds = () => getMcpControlledBackendIds();

	/**
	 * Setup WebSocket event listeners for MCP control events.
	 * Returns a teardown that removes every listener. Without it, each
	 * BrowserPreview re-mount would leave a live handler behind — surfacing as
	 * duplicate "MCP Control Started" toasts (one per stale handler).
	 */
	function setupEventListeners(): () => void {
		debug.log('preview', '🎧 Setting up MCP event listeners...');

		// Nothing about the agent's pointer is handled here any more.
		//
		// Lock, focus, caption and position all live in the always-on dock sync,
		// which keeps them per backend tab whether or not this panel is mounted
		// and whichever tab it happens to be showing. This handler used to own
		// the cursor and dropped every event for a tab that was not on screen —
		// so switching to the tab an agent was working on showed a pointer stuck
		// wherever the one restore-on-switch had put it, while the agent carried
		// on moving somewhere the panel had thrown away.
		const unsubscribers: Array<() => void> = [];

		// MCP Tab Management - Request/Response handlers
		setupTabManagementListeners();

		debug.log('preview', '✅ MCP event listeners registered');

		return () => {
			for (const unsub of unsubscribers) unsub();
		};
	}

	/**
	 * Setup tab management listeners
	 * Note: MCP tab management events have been removed in the new architecture.
	 */
	function setupTabManagementListeners() {
		// MCP tab management listeners removed - now uses HTTP request-response pattern
		// defined in backend/ws/preview/browser/mcp.ts
	}

	/**
	 * Check if current active tab is MCP controlled
	 */
	function isCurrentTabMcpControlled(): boolean {
		const activeTab = tabManager.tabs.find(t => t.id === tabManager.activeTabId);
		if (!activeTab?.sessionId) return false;
		return controlledSessionIds().has(activeTab.sessionId);
	}

	/**
	 * Check if a specific frontend tab is MCP controlled (by sessionId)
	 */
	function isSessionControlled(sessionId: string): boolean {
		return controlledSessionIds().has(sessionId);
	}

	/**
	 * Get set of frontend tab IDs that are MCP controlled
	 */
	function getControlledTabIds(): Set<string> {
		const controlled = controlledSessionIds();
		const result = new Set<string>();
		for (const tab of tabManager.tabs) {
			if (tab.sessionId && controlled.has(tab.sessionId)) {
				result.add(tab.id);
			}
		}
		return result;
	}

	/** Frontend tab ids an agent is acting on right now. */
	function getFocusedTabIds(): Set<string> {
		const result = new Set<string>();
		for (const tab of tabManager.tabs) {
			if (tab.sessionId && isBackendTabMcpFocused(tab.sessionId)) result.add(tab.id);
		}
		return result;
	}

	/** Whether the panel is currently showing a tab an agent is working on. */
	function isCurrentTabMcpFocused(): boolean {
		const activeTab = tabManager.tabs.find((t) => t.id === tabManager.activeTabId);
		return isBackendTabMcpFocused(activeTab?.sessionId ?? null);
	}

	// Private handlers

	function handleTabsListRequest(data: { requestId: string }) {
		const tabList = tabManager.tabs.map(tab => ({
			id: tab.id,
			url: tab.url,
			title: tab.title,
			sessionId: tab.sessionId,
			isActive: tab.id === tabManager.activeTabId
		}));

		ws.http('preview:mcp-tab-list', {
			requestId: data.requestId,
			tabs: tabList
		});
	}

	function handleActiveTabRequest(data: { requestId: string }) {
		const tab = tabManager.activeTab;
		ws.http('preview:mcp-active-tab', {
			requestId: data.requestId,
			tab: tab ? {
				id: tab.id,
				url: tab.url,
				title: tab.title,
				sessionId: tab.sessionId,
				isActive: true
			} : null
		});
	}

	async function handleSwitchTabRequest(data: { requestId: string; tabId: string }) {
		const tab = tabManager.getTab(data.tabId);
		if (!tab) {
			ws.http('preview:mcp-switch-tab', {
				requestId: data.requestId,
				success: false,
				error: `Tab '${data.tabId}' not found`
			});
			return;
		}

		tabManager.switchTab(data.tabId);

		ws.http('preview:mcp-switch-tab', {
			requestId: data.requestId,
			success: true,
			tab: {
				id: tab.id,
				url: tab.url,
				title: tab.title,
				sessionId: tab.sessionId,
				isActive: true
			}
		});
	}

	async function handleOpenTabRequest(data: { requestId: string; url: string }) {
		try {
			const tabId = tabManager.createTab(data.url);
			const tab = tabManager.getTab(tabId);

			// Wait for session to be created if URL provided
			if (data.url && tab) {
				// Wait up to 5 seconds for session to be ready
				let attempts = 0;
				while (attempts < 50 && !tab.sessionId) {
					await new Promise(resolve => setTimeout(resolve, 100));
					attempts++;
				}
			}

			ws.http('preview:mcp-open-tab', {
				requestId: data.requestId,
				success: true,
				tab: tab ? {
					id: tab.id,
					url: tab.url,
					title: tab.title,
					sessionId: tab.sessionId,
					isActive: true
				} : undefined
			});
		} catch (error) {
			ws.http('preview:mcp-open-tab', {
				requestId: data.requestId,
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	}

	function handleCloseTabRequest(data: { requestId: string; tabId: string }) {
		const tab = tabManager.getTab(data.tabId);
		if (!tab) {
			ws.http('preview:mcp-close-tab', {
				requestId: data.requestId,
				success: false,
				error: `Tab '${data.tabId}' not found`
			});
			return;
		}

		const { newActiveTab } = tabManager.closeTab(data.tabId);

		ws.http('preview:mcp-close-tab', {
			requestId: data.requestId,
			success: true,
			closedTabId: data.tabId,
			newActiveTab: newActiveTab ? {
				id: newActiveTab.id,
				url: newActiveTab.url,
				title: newActiveTab.title,
				sessionId: newActiveTab.sessionId,
				isActive: true
			} : undefined
		});
	}

	function handleLaunchRequest(data: { url: string; deviceSize: string; rotation: string; sessionId?: string }) {
		debug.log('preview', `🚀 MCP launch request: ${data.url}, sessionId: ${data.sessionId || 'none'}`);

		if (onLaunchRequest) {
			onLaunchRequest(data.url, data.deviceSize, data.rotation, data.sessionId);
		}
	}

	return {
		setupEventListeners,
		isCurrentTabMcpControlled,
		isCurrentTabMcpFocused,
		isSessionControlled,
		getControlledTabIds,
		getFocusedTabIds,
		get controlledSessionIds() { return controlledSessionIds(); }
	};
}

export type McpHandler = ReturnType<typeof createMcpHandler>;
