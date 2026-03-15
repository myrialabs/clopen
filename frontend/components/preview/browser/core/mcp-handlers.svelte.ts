/**
 * Browser MCP Event Handlers
 * Handles MCP (Model Context Protocol) control events for BrowserPreview
 */

import { debug } from '$shared/utils/logger';
import { showInfo, showWarning } from '$frontend/stores/ui/notification.svelte';
import ws from '$frontend/utils/ws';
import type { TabManager } from './tab-manager.svelte';

// MCP Control State interface
export interface McpControlState {
	isControlled: boolean;
	controlledTabId: string | null;
	browserSessionId: string | null;
	startedAt: number | null;
}

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

	// MCP control state
	let mcpControlState = $state<McpControlState>({
		isControlled: false,
		controlledTabId: null,
		browserSessionId: null,
		startedAt: null
	});

	/**
	 * Setup WebSocket event listeners for MCP control events
	 */
	function setupEventListeners() {
		debug.log('preview', '🎧 Setting up MCP event listeners...');

		// Listen for MCP control start/end events
		ws.on('preview:browser-mcp-control-start', (data) => {
			debug.log('preview', `📥 Received mcp-control-start:`, data);
			handleControlStart(data);
		});

		ws.on('preview:browser-mcp-control-end', (data) => {
			debug.log('preview', `📥 Received mcp-control-end:`, data);
			handleControlEnd(data);
		});

		// Listen for MCP cursor events
		ws.on('preview:browser-mcp-cursor-position', (data) => {
			handleCursorPosition(data);
		});

		ws.on('preview:browser-mcp-cursor-click', (data) => {
			handleCursorClick(data);
		});

		ws.on('preview:browser-mcp-test-completed', (data) => {
			handleTestCompleted(data);
		});

		// Hide cursor when the entire Claude request finishes or is stopped
		ws.on('chat:complete', () => {
			if (onCursorHide) onCursorHide();
		});

		ws.on('chat:cancelled', () => {
			if (onCursorHide) onCursorHide();
		});

		// MCP Tab Management - Request/Response handlers
		setupTabManagementListeners();

		debug.log('preview', '✅ MCP event listeners registered');
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
	 * Check if current tab is MCP controlled
	 */
	function isCurrentTabMcpControlled(): boolean {
		return mcpControlState.isControlled && mcpControlState.controlledTabId === tabManager.activeTabId;
	}

	/**
	 * Get MCP control state
	 */
	function getControlState(): McpControlState {
		return mcpControlState;
	}

	// Private handlers

	function handleControlStart(data: { browserSessionId: string; mcpSessionId?: string; timestamp: number }) {
		debug.log('preview', `🎮 MCP control started for session: ${data.browserSessionId}`);

		// Find which tab has this session
		const tab = tabManager.tabs.find(t => t.sessionId === data.browserSessionId);

		mcpControlState = {
			isControlled: true,
			controlledTabId: tab?.id || null,
			browserSessionId: data.browserSessionId,
			startedAt: data.timestamp
		};

		// Show toast notification
		showWarning('MCP Control Started', 'An MCP agent is now controlling the browser. User input is blocked.', 5000);
	}

	function handleControlEnd(data: { browserSessionId: string; timestamp: number }) {
		debug.log('preview', `🎮 MCP control ended for session: ${data.browserSessionId}`);

		mcpControlState = {
			isControlled: false,
			controlledTabId: null,
			browserSessionId: null,
			startedAt: null
		};

		// Hide cursor
		if (onCursorHide) {
			onCursorHide();
		}

		// Show toast notification
		showInfo('MCP Control Ended', 'MCP agent released control. You can now interact with the browser.', 4000);
	}

	function handleCursorPosition(data: { sessionId: string; x: number; y: number; timestamp: number; source: 'mcp' }) {
		// Only show cursor if MCP is controlling AND user is currently viewing that tab
		if (mcpControlState.isControlled && mcpControlState.browserSessionId === data.sessionId && isCurrentTabMcpControlled() && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, false);
			}
		}
	}

	function handleCursorClick(data: { sessionId: string; x: number; y: number; timestamp: number; source: 'mcp' }) {
		// Only show cursor click if MCP is controlling AND user is currently viewing that tab
		if (mcpControlState.isControlled && mcpControlState.browserSessionId === data.sessionId && isCurrentTabMcpControlled() && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, true);
			}
		}
	}

	/**
	 * Restore MCP control state after session recovery (browser refresh or project switch)
	 * Called when recovered backend tab was previously MCP-controlled
	 */
	function restoreControlState(frontendTabId: string, browserSessionId: string): void {
		debug.log('preview', `🔄 Restoring MCP control state for tab: ${frontendTabId} (session: ${browserSessionId})`);
		mcpControlState = {
			isControlled: true,
			controlledTabId: frontendTabId,
			browserSessionId: browserSessionId,
			startedAt: Date.now()
		};
	}

	/**
	 * Reset MCP control state (called before project switch recovery)
	 */
	function resetControlState(): void {
		debug.log('preview', `🔄 Resetting MCP control state`);
		mcpControlState = {
			isControlled: false,
			controlledTabId: null,
			browserSessionId: null,
			startedAt: null
		};
		if (onCursorHide) {
			onCursorHide();
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
		getControlState,
		restoreControlState,
		resetControlState,
		get mcpControlState() { return mcpControlState; }
	};
}

export type McpHandler = ReturnType<typeof createMcpHandler>;
