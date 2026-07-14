/**
 * Browser MCP Event Handlers
 * Handles MCP (Model Context Protocol) control events for BrowserPreview
 *
 * Supports multi-tab control: each chat session can control multiple tabs.
 * Tracks controlled tabs via a Set of backend tab IDs (session IDs).
 */

import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import { getMcpControlledBackendIds } from '$frontend/stores/features/preview-tabs-workspace.svelte';
import type { TabManager } from './tab-manager.svelte';

export interface McpHandlerConfig {
	tabManager: TabManager;
	transformBrowserToDisplayCoordinates?: (x: number, y: number) => { x: number, y: number } | null;
	onCursorUpdate?: (x: number, y: number, clicking?: boolean) => void;
	onCursorHide?: () => void;
	onLaunchRequest?: (url: string, deviceSize: string, rotation: string, sessionId?: string) => void;
}

/**
 * Create MCP event handler
 */
export function createMcpHandler(config: McpHandlerConfig) {
	const { tabManager, transformBrowserToDisplayCoordinates, onCursorUpdate, onCursorHide, onLaunchRequest } = config;

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

		const unsubscribers = [
			// MCP control start/end (which tabs are controlled + toasts) is handled by
			// the always-on dock sync, not here — this handler is view-scoped and only
			// exists while the panel is mounted. Cursor rendering stays here because it
			// needs the live canvas transform.

			// Listen for MCP cursor events
			ws.on('preview:browser-mcp-cursor-position', (data) => {
				handleCursorPosition(data);
			}),

			ws.on('preview:browser-mcp-cursor-click', (data) => {
				handleCursorClick(data);
			}),

			ws.on('preview:browser-mcp-test-completed', (data) => {
				handleTestCompleted(data);
			}),

			// Hide cursor when the entire Claude request finishes or is stopped
			ws.on('chat:complete', () => {
				if (onCursorHide) onCursorHide();
			}),

			ws.on('chat:cancelled', () => {
				if (onCursorHide) onCursorHide();
			})
		];

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

	// Private handlers

	function handleCursorPosition(data: { sessionId: string; x: number; y: number; timestamp: number; source: 'mcp' }) {
		// Only show cursor if this tab is controlled AND user is viewing it
		const activeTab = tabManager.tabs.find(t => t.id === tabManager.activeTabId);
		if (activeTab?.sessionId === data.sessionId && controlledSessionIds().has(data.sessionId) && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, false);
			}
		}
	}

	function handleCursorClick(data: { sessionId: string; x: number; y: number; timestamp: number; source: 'mcp' }) {
		// Only show cursor click if this tab is controlled AND user is viewing it
		const activeTab = tabManager.tabs.find(t => t.id === tabManager.activeTabId);
		if (activeTab?.sessionId === data.sessionId && controlledSessionIds().has(data.sessionId) && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, true);
			}
		}
	}

	function handleTestCompleted(_data: { sessionId: string; timestamp: number; source: 'mcp' }) {
		// Cursor is hidden via chat:complete / chat:cancelled listeners instead,
		// because test-completed fires per-tool-call, not at end of full request.
	}

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
		isSessionControlled,
		getControlledTabIds,
		get controlledSessionIds() { return controlledSessionIds(); }
	};
}

export type McpHandler = ReturnType<typeof createMcpHandler>;
