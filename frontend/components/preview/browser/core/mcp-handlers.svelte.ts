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
	getMcpFocusedBackendId
} from '$frontend/stores/features/preview-tabs-workspace.svelte';
import type { TabManager } from './tab-manager.svelte';

export interface McpHandlerConfig {
	tabManager: TabManager;
	/**
	 * Cursor updates are handed up in *page* coordinates, not screen ones.
	 *
	 * Converting here meant dropping the event whenever the canvas had not
	 * painted yet (no bitmap, no painted rect, no conversion) — and a dropped
	 * cursor event never comes back. The panel keeps the page position and
	 * re-projects it whenever the canvas geometry changes instead.
	 */
	onCursorUpdate?: (x: number, y: number, clicking?: boolean, pressed?: boolean) => void;
	onCursorHide?: () => void;
	onLaunchRequest?: (url: string, deviceSize: string, rotation: string, sessionId?: string) => void;
}

/**
 * Create MCP event handler
 */
export function createMcpHandler(config: McpHandlerConfig) {
	const { tabManager, onCursorUpdate, onCursorHide, onLaunchRequest } = config;

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

			// The end-of-control signal, and now the only one: the tab is handed
			// back the moment the owning chat session releases it, which is when
			// the pointer stops meaning anything.
			//
			// `chat:complete`/`chat:cancelled` used to hide the pointer here too,
			// as a backstop. They are worse than redundant now that the pointer is
			// drawn from the lock itself: a stream ends by releasing its tabs, so
			// the backstop only ever fired *before* the release it was covering
			// for — and took the pointer off a tab the agent still held. A release
			// that genuinely never happens leaves the tab locked as well, which is
			// the orphan sweep's job on the backend, not something to paper over
			// by drawing a lock that is real as though it were not.
			ws.on('preview:browser-mcp-control-end', (data) => {
				forgetCursor(data.browserTabId);
				const activeTab = tabManager.tabs.find(t => t.id === tabManager.activeTabId);
				if (activeTab?.sessionId === data.browserTabId) onCursorHide?.();
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

	/** The frontend tab the agent is acting on right now, if it is on screen. */
	function getFocusedTabId(): string | null {
		const focused = getMcpFocusedBackendId();
		if (!focused) return null;
		return tabManager.tabs.find((tab) => tab.sessionId === focused)?.id ?? null;
	}

	/** Whether the panel is currently showing the tab the agent is working on. */
	function isCurrentTabMcpFocused(): boolean {
		const activeTab = tabManager.tabs.find((t) => t.id === tabManager.activeTabId);
		return !!activeTab?.sessionId && activeTab.sessionId === getMcpFocusedBackendId();
	}

	// Private handlers

	/**
	 * Where the agent's pointer was last seen on each tab.
	 *
	 * An agent that has finished moving sends nothing more, so a pointer parked
	 * on a tab the user was not watching had no way to reappear when they
	 * switched to it — the panel cleared its cursor on every tab change and
	 * nothing would ever redraw it. Remembering the last position is what makes
	 * "look at whichever tab you like" work with the agent still holding one.
	 */
	const lastCursorBySession = new Map<string, { x: number; y: number; pressed: boolean }>();

	/**
	 * The agent's last known pointer on a tab, for restoring after a switch.
	 *
	 * Gated on the tab still being controlled: a release that happened while
	 * this panel was unmounted never reached `forgetCursor`, and drawing a
	 * pointer for an agent that has already left is worse than drawing none.
	 */
	function getCursorFor(sessionId: string | null): { x: number; y: number; pressed: boolean } | null {
		if (!sessionId || !controlledSessionIds().has(sessionId)) return null;
		return lastCursorBySession.get(sessionId) ?? null;
	}

	/**
	 * Hand an agent cursor event up to the panel.
	 *
	 * The only gate is "is this the tab on screen" — there is nothing to draw
	 * on otherwise. It deliberately does *not* also require the tab to be in
	 * the controlled set: these events are only ever emitted by an agent, and
	 * control-start is a separate message that can arrive after the first
	 * gesture, so gating on it can hide the cursor for an entire run.
	 */
	function applyCursor(
		data: { sessionId: string; x: number; y: number; pressed?: boolean },
		clicking: boolean
	) {
		// Recorded before the gate: the position matters even — especially —
		// while the user is looking somewhere else.
		lastCursorBySession.set(data.sessionId, {
			x: data.x,
			y: data.y,
			pressed: !!data.pressed
		});

		const activeTab = tabManager.tabs.find(t => t.id === tabManager.activeTabId);

		if (!activeTab?.sessionId) {
			debug.log('preview', `🖱️ [mcp-cursor] deferred: no session on the active tab (event for ${data.sessionId})`);
			return;
		}

		if (activeTab.sessionId !== data.sessionId) {
			debug.log('preview', `🖱️ [mcp-cursor] deferred: event for ${data.sessionId}, viewing ${activeTab.sessionId}`);
			return;
		}

		onCursorUpdate?.(data.x, data.y, clicking, data.pressed);
	}

	/** Forget a tab's pointer once the agent has handed the tab back. */
	function forgetCursor(sessionId: string): void {
		lastCursorBySession.delete(sessionId);
	}

	function handleCursorPosition(data: { sessionId: string; x: number; y: number; pressed?: boolean; timestamp: number; source: 'mcp' }) {
		applyCursor(data, false);
	}

	function handleCursorClick(data: { sessionId: string; x: number; y: number; timestamp: number; source: 'mcp' }) {
		applyCursor(data, true);
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
		isCurrentTabMcpFocused,
		isSessionControlled,
		getControlledTabIds,
		getFocusedTabId,
		getCursorFor,
		get controlledSessionIds() { return controlledSessionIds(); }
	};
}

export type McpHandler = ReturnType<typeof createMcpHandler>;
