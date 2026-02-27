/**
 * Browser Stream Message Handler
 * Handles stream messages from backend for BrowserPreview
 */

import { debug } from '$shared/utils/logger';
import type { PreviewTab, TabManager } from './tab-manager.svelte';
import { getTabTitle } from './tab-manager.svelte';

export interface StreamMessageHandlerConfig {
	tabManager: TabManager;
	onNavigationUpdate?: (tabId: string, url: string) => void;
	onCursorUpdate?: (x: number, y: number, clicking?: boolean) => void;
	onTestCompleted?: () => void;
	transformBrowserToDisplayCoordinates?: (x: number, y: number) => { x: number, y: number } | null;
}

/**
 * Create stream message handler
 */
export function createStreamMessageHandler(config: StreamMessageHandlerConfig) {
	const { tabManager, onNavigationUpdate, onCursorUpdate, onTestCompleted, transformBrowserToDisplayCoordinates } = config;

	/**
	 * Handle stream messages for a specific tab
	 */
	function handleStreamMessage(message: any, tabId?: string) {
		const targetTabId = tabId || tabManager.activeTabId;
		if (!targetTabId) return;

		const tab = tabManager.getTab(targetTabId);
		if (!tab) return;

		// Debug logging for navigation events
		if (message.type === 'navigation' || message.type === 'navigation-loading') {
			debug.log('preview', `📢 [${message.type}] Tab: ${targetTabId}, URL: ${message.data?.url}, Active: ${targetTabId === tabManager.activeTabId}`);
		}

		switch (message.type) {
			case 'session-info':
				handleSessionInfo(targetTabId, message.data, tab);
				break;

			case 'screencast-frame':
				handleScreencastFrame(targetTabId, message.data);
				break;

			case 'cursor-position':
				handleCursorPosition(targetTabId, message.data);
				break;

			case 'cursor-click':
				handleCursorClick(targetTabId, message.data);
				break;

			case 'test-completed':
				handleTestCompleted(targetTabId);
				break;

			case 'console-message':
				handleConsoleMessage(targetTabId, message.data, tab);
				break;

			case 'console-clear':
				handleConsoleClear(targetTabId);
				break;

			case 'navigation-loading':
				handleNavigationLoading(targetTabId, message.data);
				break;

			case 'navigation':
				handleNavigation(targetTabId, message.data, tab);
				break;

			case 'new-window':
				handleNewWindow(message.data);
				break;

			case 'ping':
				// Ignore ping messages
				break;

			case 'error':
				debug.error('preview', 'Stream error:', message.message);
				break;

			default:
				debug.warn('preview', 'Unknown stream message type:', message.type);
		}
	}

	/**
	 * Handle connection change
	 */
	function handleConnectionChange(connected: boolean, tabId?: string) {
		const targetTabId = tabId || tabManager.activeTabId;
		if (!targetTabId) return;

		tabManager.updateTab(targetTabId, { isConnected: connected });
	}

	// Private handlers

	function handleSessionInfo(tabId: string, data: any, tab: PreviewTab) {
		tabManager.updateTab(tabId, {
			sessionInfo: data,
			deviceSize: data.deviceSize || tab.deviceSize,
			rotation: data.rotation || tab.rotation
		});

		// Setup canvas if this is the active tab
		if (tabId === tabManager.activeTabId && tab.canvasAPI) {
			tab.canvasAPI.setupCanvas();
		}
	}

	function handleScreencastFrame(tabId: string, data: any) {
		const tab = tabManager.getTab(tabId);
		const updates: any = { lastFrameData: data };

		// If tab is navigating, complete navigation when new frame is received
		if (tab?.isNavigating) {
			updates.isNavigating = false;
			debug.log('preview', `✅ Navigation frame received for tab: ${tabId}, completing progress`);
		}

		tabManager.updateTab(tabId, updates);

		if (tabId === tabManager.activeTabId) {
			debug.log('preview', `🎬 Screencast frame received for active tab: ${tabId}`);
		}
	}

	function handleCursorPosition(tabId: string, data: any) {
		if (data && tabId === tabManager.activeTabId && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, false);
			}
		}
	}

	function handleCursorClick(tabId: string, data: any) {
		if (data && tabId === tabManager.activeTabId && transformBrowserToDisplayCoordinates) {
			const transformedPosition = transformBrowserToDisplayCoordinates(data.x, data.y);
			if (transformedPosition && onCursorUpdate) {
				onCursorUpdate(transformedPosition.x, transformedPosition.y, true);
			}
		}
	}

	function handleTestCompleted(tabId: string) {
		if (tabId === tabManager.activeTabId && onTestCompleted) {
			onTestCompleted();
		}
	}

	function handleConsoleMessage(tabId: string, data: any, tab: PreviewTab) {
		if (data && data.message) {
			const tabLogs = [...(tab.consoleLogs || []), data.message];
			// Keep only last 1000 messages for performance
			const trimmedLogs = tabLogs.length > 1000 ? tabLogs.slice(-500) : tabLogs;
			tabManager.updateTab(tabId, { consoleLogs: trimmedLogs });
		}
	}

	function handleConsoleClear(tabId: string) {
		tabManager.updateTab(tabId, { consoleLogs: [] });
	}

	function handleNavigationLoading(tabId: string, data: any) {
		if (data && data.url) {
			const tab = tabManager.getTab(tabId);
			// isNavigating: true if session already exists (navigating within same session)
			// isNavigating: false if no session yet (initial load)
			const isNavigating = tab?.sessionId ? true : false;

			tabManager.updateTab(tabId, {
				isLoading: true,
				isNavigating,
				url: data.url,
				title: getTabTitle(data.url)
			});

			// Only update parent if this is the active tab AND not already navigating via HTTP
			// When navigating via HTTP (Go button), the HTTP response will handle URL updates
			// to avoid race conditions with stream events overwriting the final redirected URL
			if (tabId === tabManager.activeTabId && onNavigationUpdate && !tab?.isNavigating) {
				onNavigationUpdate(tabId, data.url);
			}
		}
	}

	function handleNavigation(tabId: string, data: any, tab: PreviewTab) {
		if (data && data.url && data.url !== tab.url) {
			debug.log('preview', `🧭 Navigation completed for tab ${tabId}: ${tab.url} → ${data.url}`);
			tabManager.updateTab(tabId, {
				isLoading: false,
				isNavigating: false,
				url: data.url,
				title: getTabTitle(data.url)
			});

			// Only update parent if this is the active tab
			if (tabId === tabManager.activeTabId && onNavigationUpdate) {
				onNavigationUpdate(tabId, data.url);
			}
		} else if (data && data.url === tab.url) {
			// Same URL but navigation completed (e.g., page refresh)
			debug.log('preview', `🔄 Same URL navigation completed for tab ${tabId}: ${data.url}`);
			tabManager.updateTab(tabId, {
				isLoading: false,
				isNavigating: false
			});
		}
	}

	function handleNewWindow(data: any) {
		if (data && data.url) {
			tabManager.createTab(data.url);
		}
	}

	return {
		handleStreamMessage,
		handleConnectionChange
	};
}

export type StreamMessageHandler = ReturnType<typeof createStreamMessageHandler>;
