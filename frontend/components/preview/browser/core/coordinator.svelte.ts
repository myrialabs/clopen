/**
 * Browser Coordinator
 * Coordinates all browser preview services and state management
 */

import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';
import { type TabManager } from './tab-manager.svelte';
import { createStreamMessageHandler, type StreamMessageHandler } from './stream-handler.svelte';
import { createNativeUIHandler, type NativeUIHandler } from './native-ui-handlers.svelte';
import { createMcpHandler, type McpHandler } from './mcp-handlers.svelte';
import {
	launchBrowser as launchBrowserOp,
	navigateBrowser as navigateBrowserOp,
	destroyBrowser,
	destroyBrowserTab,
	switchToBackendTab
} from './tab-operations.svelte';
import { browserCleanup } from './cleanup.svelte';
import { sendInteraction, updateViewport, setInteractionProjectId } from './interactions.svelte';
import { previewTabManager } from '$frontend/stores/features/preview-tabs-workspace.svelte';
import type { BrowserSelectInfo, BrowserContextMenuInfo } from '$frontend/utils/native-ui';

export interface BrowserCoordinatorConfig {
	// Project ID getter (REQUIRED for project isolation)
	projectId: () => string;

	// Callbacks from parent component
	onUrlChange?: (url: string) => void;
	onUrlInputChange?: (urlInput: string) => void;
	onSessionChange?: (sessionId: string | null) => void;
	onLoadingChange?: (isLoading: boolean) => void;
	onErrorChange?: (errorMessage: string | null) => void;

	// UI state callbacks
	onSelectOpen?: (selectInfo: BrowserSelectInfo) => void;
	onContextMenuOpen?: (menuInfo: BrowserContextMenuInfo) => void;
	onVirtualCursorUpdate?: (x: number, y: number, clicking?: boolean) => void;
	onVirtualCursorHide?: () => void;
	onMcpCursorUpdate?: (x: number, y: number, clicking?: boolean) => void;
	onMcpCursorHide?: () => void;

	// Coordinate transformation
	transformBrowserToDisplayCoordinates?: (x: number, y: number) => { x: number, y: number } | null;
}

/**
 * Create browser coordinator
 */
export function createBrowserCoordinator(config: BrowserCoordinatorConfig) {
	const {
		projectId: getProjectId,
		onUrlChange,
		onUrlInputChange,
		onSessionChange,
		onLoadingChange,
		onErrorChange,
		onSelectOpen,
		onContextMenuOpen,
		onVirtualCursorUpdate,
		onVirtualCursorHide,
		onMcpCursorUpdate,
		onMcpCursorHide,
		transformBrowserToDisplayCoordinates
	} = config;

	// Use the module-level singleton tab manager. It is populated by the
	// preview-tabs dock's load() during the workspace switch barrier, so tabs are
	// already authoritative by the time BrowserPreview mounts/re-renders.
	const tabManager = previewTabManager;

	// WS listener teardown handles, removed on cleanup(). The handlers operate on
	// the shared singleton, so a per-mount registration that is never torn down
	// accumulates across re-mounts — surfacing as duplicate event handling and
	// duplicate "MCP Control Started" toasts.
	const disposers: Array<() => void> = [];
	let disposed = false;

	function track(unsub: () => void): void {
		if (disposed) {
			// cleanup() already ran (e.g. an async import resolved after unmount).
			unsub();
			return;
		}
		disposers.push(unsub);
	}

	// Create stream handler
	const streamHandler = createStreamMessageHandler({
		tabManager,
		onNavigationUpdate: (tabId, url) => {
			// Only notify parent if this is the active tab
			if (tabId === tabManager.activeTabId) {
				if (onUrlChange) onUrlChange(url);
				if (onUrlInputChange) onUrlInputChange(url);
			}
		},
		onCursorUpdate: (x, y, clicking) => {
			if (onVirtualCursorUpdate) {
				onVirtualCursorUpdate(x, y, clicking);
			}
		},
		onTestCompleted: () => {
			if (onVirtualCursorHide) {
				onVirtualCursorHide();
			}
		},
		transformBrowserToDisplayCoordinates
	});

	// Create native UI handler
	const nativeUIHandler = createNativeUIHandler({
		tabManager,
		transformBrowserToDisplayCoordinates,
		onSelectOpen,
		onContextMenuOpen,
		onOpenUrlNewTab: (url) => {
			createNewTab(url);
		}
	});

	// Create MCP handler
	const mcpHandler = createMcpHandler({
		tabManager,
		transformBrowserToDisplayCoordinates,
		onCursorUpdate: (x, y, clicking) => {
			if (onMcpCursorUpdate) {
				onMcpCursorUpdate(x, y, clicking);
			}
		},
		onCursorHide: () => {
			if (onMcpCursorHide) {
				onMcpCursorHide();
			}
		},
		onLaunchRequest: (url, deviceSize, rotation, sessionId) => {
			handleMcpLaunchRequest(url, deviceSize, rotation, sessionId);
		}
	});

	// Browser session management

	/**
	 * Launch browser for a tab
	 */
	async function launchBrowserForTab(tabId: string, tabUrl: string, mcpSessionId?: string) {
		debug.log('preview', `🚀 launchBrowserForTab called - tabId: ${tabId}, url: ${tabUrl}${mcpSessionId ? `, mcpSessionId: ${mcpSessionId}` : ''}`);

		const tab = tabManager.getTab(tabId);
		if (!tab || !tabUrl) {
			debug.error('preview', `❌ Tab not found or no URL: ${tabId}`);
			return;
		}

		try {
			tabManager.updateTab(tabId, { isLaunchingBrowser: true, errorMessage: null });

			// Get current projectId
			const projectId = getProjectId();
			const result = await launchBrowserOp(tabUrl, tab.deviceSize, tab.rotation, projectId, mcpSessionId);

			if (result.success && result.sessionId && result.sessionInfo) {
				debug.log('preview', `✅ Browser launched successfully - sessionId: ${result.sessionId}`);

				// Register session for cleanup tracking
				browserCleanup.registerSession(result.sessionId);

				// Use the actual URL from backend (which may be different due to redirects)
				const actualUrl = result.sessionInfo.url || tabUrl;

				tabManager.updateTab(tabId, {
					sessionId: result.sessionId,
					sessionInfo: result.sessionInfo,
					url: actualUrl,
					lastFrameData: null,
					errorMessage: null
				});

				// Notify parent if active tab
				if (tabId === tabManager.activeTabId) {
					if (onSessionChange) onSessionChange(result.sessionId);
					if (onUrlChange) onUrlChange(actualUrl);
					if (onUrlInputChange) onUrlInputChange(actualUrl);
					if (onErrorChange) onErrorChange(null);
				}

				// Backend created this tab with setActive=true, which may override a tab switch
				// that happened while the 60-second launch call was awaiting. Re-assert the
				// correct active tab on the backend if the user switched away during launch.
				if (tabId !== tabManager.activeTabId && tabManager.activeTabId) {
					const currentActiveTab = tabManager.getTab(tabManager.activeTabId);
					if (currentActiveTab?.sessionId) {
						debug.log('preview', `🔄 Tab switched during launch — re-asserting active backend tab: ${tabManager.activeTabId}`);
						void switchToBackendTab(currentActiveTab.sessionId, getProjectId());
					}
				}

				} else {
				const errorMsg = result.error || 'Unknown error';
				debug.error('preview', `❌ Browser launch failed:`, errorMsg);
				tabManager.updateTab(tabId, { errorMessage: errorMsg });

				if (tabId === tabManager.activeTabId && onErrorChange) {
					onErrorChange(errorMsg);
				}
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			debug.error('preview', `💥 Exception in launchBrowserForTab:`, error);
			tabManager.updateTab(tabId, { errorMessage: `Exception: ${errorMsg}` });

			if (tabId === tabManager.activeTabId && onErrorChange) {
				onErrorChange(`Exception: ${errorMsg}`);
			}
		} finally {
			tabManager.updateTab(tabId, { isLaunchingBrowser: false });
		}
	}

	/**
	 * Navigate browser for a tab
	 */
	async function navigateBrowserForTab(tabId: string, newUrl: string) {
		const tab = tabManager.getTab(tabId);
		if (!tab || !tab.sessionId) return;

		try {
			// Set isNavigating since we have an existing session
			tabManager.updateTab(tabId, { isLoading: true, isNavigating: true, errorMessage: null });

			// Get current projectId
			const projectId = getProjectId();
			// Send explicit tabId (backend sessionId) to prevent cross-contamination during rapid switching
			const result = await navigateBrowserOp(newUrl, projectId, tab.sessionId);

			if (result.success) {
				const finalUrl = result.finalUrl || newUrl;
				tabManager.updateTab(tabId, {
					url: finalUrl,
					errorMessage: null
				});

				// Notify parent if active tab
				if (tabId === tabManager.activeTabId) {
					if (onUrlChange) onUrlChange(finalUrl);
					if (onUrlInputChange) onUrlInputChange(finalUrl);
					if (onErrorChange) onErrorChange(null);
				}
			} else {
				const errorMsg = result.error || 'Navigation failed';
				debug.error('preview', `❌ Browser navigation failed:`, errorMsg);
				tabManager.updateTab(tabId, { errorMessage: errorMsg, isNavigating: false });

				if (tabId === tabManager.activeTabId && onErrorChange) {
					onErrorChange(errorMsg);
				}
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : 'Unknown error';
			debug.error('preview', `💥 Exception in navigateBrowserForTab:`, error);
			tabManager.updateTab(tabId, { errorMessage: `Exception: ${errorMsg}`, isNavigating: false });

			if (tabId === tabManager.activeTabId && onErrorChange) {
				onErrorChange(`Exception: ${errorMsg}`);
			}
		} finally {
			tabManager.updateTab(tabId, { isLoading: false });
			// Note: isNavigating will be cleared when new frame arrives (in stream-handler)
		}
	}

	/**
	 * Create new tab
	 */
	function createNewTab(tabUrl: string = ''): string {
		const tabId = tabManager.createTab(tabUrl);

		// Update parent state
		if (onUrlChange) onUrlChange(tabUrl);
		if (onUrlInputChange) onUrlInputChange(tabUrl);

		// Launch browser if URL is provided
		if (tabUrl) {
			setTimeout(() => {
				launchBrowserForTab(tabId, tabUrl);
			}, 0);
		}

		return tabId;
	}

	/**
	 * Switch to tab
	 */
	async function switchToTab(tabId: string) {
		const tab = tabManager.switchTab(tabId);
		if (!tab) return;

		// If this tab has a backend session, switch backend to it
		// This ensures streaming comes from the correct backend tab
		if (tab.sessionId) {
			const projectId = getProjectId();
			await switchToBackendTab(tab.sessionId, projectId);
		}

		// Notify parent of state changes
		if (onUrlChange) onUrlChange(tab.url);
		if (onUrlInputChange) onUrlInputChange(tab.url);
		if (onSessionChange) onSessionChange(tab.sessionId);
		if (onLoadingChange) onLoadingChange(tab.isLoading);
		if (onErrorChange) onErrorChange(tab.errorMessage);
	}

	/**
	 * Close tab - explicitly destroys backend session
	 */
	function closeTab(tabId: string) {
		const tab = tabManager.getTab(tabId);
		if (!tab) return;

		// Cleanup session - explicitly destroy the backend tab
		if (tab.sessionId) {
			browserCleanup.unregisterSession(tab.sessionId);
			const projectId = getProjectId();
			destroyBrowserTab(tab.sessionId, projectId); // Use specific tab ID, not active tab
		}

		const { newActiveTab } = tabManager.closeTab(tabId);

		// Check if there are any tabs left
		const tabsLeft = tabManager.getAllTabs().length;

		// If no tabs left, create a new empty tab
		if (tabsLeft === 0) {
			debug.log('preview', '📝 No tabs left after close, creating new empty tab');
			createNewTab('');
			return;
		}

		// Update parent state if we switched to a new active tab
		if (newActiveTab) {
			if (onUrlChange) onUrlChange(newActiveTab.url);
			if (onUrlInputChange) onUrlInputChange(newActiveTab.url);
			if (onSessionChange) onSessionChange(newActiveTab.sessionId);
			if (onLoadingChange) onLoadingChange(newActiveTab.isLoading);
			if (onErrorChange) onErrorChange(newActiveTab.errorMessage);
		}
		// If newActiveTab is null but tabs still exist, it means we closed a non-active tab
		// In this case, don't update parent state as the active tab hasn't changed
	}

	/**
	 * Handle device size change
	 * When changing device, reset to that device's natural default rotation
	 */
	function changeDeviceSize(newSize: DeviceSize, scale?: number) {
		if (!tabManager.activeTabId) return;

		const tab = tabManager.activeTab;
		if (!tab || tab.deviceSize === newSize) return;

		// Reset to device's natural default rotation:
		// - Desktop/laptop: landscape (natural default)
		// - Tablet/mobile: portrait (natural default)
		const finalRotation: Rotation = (newSize === 'desktop' || newSize === 'laptop') ? 'landscape' : 'portrait';

		// Update tab state
		tabManager.updateTab(tabManager.activeTabId, {
			deviceSize: newSize,
			rotation: finalRotation
		});

		// Hot-swap viewport if session is active
		if (tab.sessionId && scale) {
			setTimeout(() => {
				updateViewport(newSize, finalRotation, scale);
			}, 100);
		}
	}

	/**
	 * Toggle rotation
	 */
	function toggleRotation(scale?: number) {
		if (!tabManager.activeTabId) return;

		const tab = tabManager.activeTab;
		if (!tab) return;

		const newRotation = tab.rotation === 'portrait' ? 'landscape' : 'portrait';

		// Update tab state
		tabManager.updateTab(tabManager.activeTabId, {
			rotation: newRotation
		});

		// Hot-swap viewport if session is active
		if (tab.sessionId && scale) {
			setTimeout(() => {
				updateViewport(tab.deviceSize, newRotation, scale);
			}, 100);
		}
	}

	/**
	 * Handle MCP launch request
	 */
	function handleMcpLaunchRequest(url: string, deviceSize: string, rotation: string, sessionId?: string) {
		if (tabManager.activeTabId) {
			const tab = tabManager.activeTab;
			if (tab && !tab.sessionId) {
				const finalDeviceSize = (deviceSize || 'laptop') as DeviceSize;
				// Use device-appropriate default rotation if not specified
				const finalRotation = rotation
					? (rotation as Rotation)
					: ((finalDeviceSize === 'desktop' || finalDeviceSize === 'laptop') ? 'landscape' : 'portrait');

				// Use existing empty tab
				tabManager.updateTab(tabManager.activeTabId, {
					url: url,
					deviceSize: finalDeviceSize,
					rotation: finalRotation
				});
				launchBrowserForTab(tabManager.activeTabId, url, sessionId);
			} else {
				// Create new tab
				createNewTabWithMcpSession(url, sessionId);
			}
		} else {
			// Create new tab
			createNewTabWithMcpSession(url, sessionId);
		}
	}

	/**
	 * Create new tab with MCP session
	 */
	function createNewTabWithMcpSession(tabUrl: string, mcpSessionId?: string): string {
		const tabId = tabManager.createTab(tabUrl);

		// Update parent state
		if (onUrlChange) onUrlChange(tabUrl);
		if (onUrlInputChange) onUrlInputChange(tabUrl);

		// Launch browser with MCP sessionId
		if (tabUrl) {
			setTimeout(() => {
				launchBrowserForTab(tabId, tabUrl, mcpSessionId);
			}, 0);
		}

		return tabId;
	}

	/**
	 * Initialize event listeners
	 * NOTE: Session recovery is now handled by the project change watcher in BrowserPreview.svelte
	 * to ensure projectId is available before attempting recovery
	 */
	function initialize() {
		disposed = false;
		browserCleanup.initialize();
		track(nativeUIHandler.setupEventListeners());
		track(mcpHandler.setupEventListeners());

		// Tab-lifecycle listeners (open/close/switch/viewport + MCP control) live in
		// the always-on dock sync (initPreviewTabSync) so they fire even when this
		// panel is unmounted. Only view-scoped navigation listeners remain here.
		setupNavigationListeners();
	}

	/**
	 * Setup navigation event listeners
	 */
	function setupNavigationListeners() {
		// Import ws at runtime to avoid circular dependencies
		import('$frontend/utils/ws').then(({ default: ws }) => {
			// Register + track so listeners are removed on unmount.
			const on = (event: any, cb: any) => track((ws.on as any)(event, cb));

			// Listen for navigation loading events
			on('preview:browser-navigation-loading', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
				debug.log('preview', `🔄 Navigation loading event received: ${data.sessionId} → ${data.url}`);

				// Find tab by sessionId (backend sends backend tab ID as sessionId)
				const tab = tabManager.tabs.find(t => t.sessionId === data.sessionId);
				if (tab) {
					streamHandler.handleStreamMessage({
						type: 'navigation-loading',
						data: { url: data.url }
					}, tab.id);
				} else {
					debug.warn('preview', `Tab not found for sessionId: ${data.sessionId}`);
				}
			});

			// Listen for navigation completed events
			on('preview:browser-navigation', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
				debug.log('preview', `✅ Navigation completed event received: ${data.sessionId} → ${data.url}`);

				// Find tab by sessionId (backend sends backend tab ID as sessionId)
				const tab = tabManager.tabs.find(t => t.sessionId === data.sessionId);
				if (tab) {
					streamHandler.handleStreamMessage({
						type: 'navigation',
						data: { url: data.url }
					}, tab.id);
				} else {
					debug.warn('preview', `Tab not found for sessionId: ${data.sessionId}`);
				}
			});

			// Listen for SPA navigation events (pushState/replaceState)
			on('preview:browser-navigation-spa', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
				debug.log('preview', `🔄 SPA navigation event received: ${data.sessionId} → ${data.url}`);

				const tab = tabManager.tabs.find(t => t.sessionId === data.sessionId);
				if (tab) {
					streamHandler.handleStreamMessage({
						type: 'navigation-spa',
						data: { url: data.url }
					}, tab.id);
				}
			});
		});
	}

	/**
	 * Cleanup frontend state only (called on component destroy)
	 *
	 * NOTE: This does NOT destroy backend sessions.
	 * Backend sessions are preserved to allow reconnection after page refresh.
	 * To explicitly close tabs, use closeTab() which calls destroyBrowser().
	 */
	async function cleanup() {
		// Remove every WS listener registered for this mount so handlers don't
		// pile up across re-mounts (the root cause of duplicate events/toasts).
		disposed = true;
		for (const dispose of disposers) {
			try {
				dispose();
			} catch (err) {
				debug.warn('preview', 'Listener teardown failed:', err);
			}
		}
		disposers.length = 0;

		// Just clear frontend tracking - don't destroy backend sessions
		// Backend sessions will be recovered on next page load
		browserCleanup.clearAll();
		debug.log('preview', '🧹 Frontend cleanup complete (backend sessions preserved)');
	}

	/**
	 * Sync the per-coordinator state with the singleton tab manager.
	 *
	 * The preview-tabs dock's load() runs inside the workspace switch barrier
	 * and populates `previewTabManager` from backend before the panel reveals,
	 * so this just adopts that authoritative state: hands MCP-controlled tabs to
	 * the per-mount mcpHandler and fires the parent's UI callbacks once.
	 */
	async function switchProject() {
		const newProjectId = getProjectId();
		debug.log('preview', `🔄 Switching to project: ${newProjectId}`);

		// Keep interactions' projectId in sync (dock load() also does this on
		// project switches; this covers the no-switch path, e.g. panel re-mount).
		setInteractionProjectId(newProjectId);

		// MCP control state is owned by the always-on dock sync (seeded from the
		// backend in load(), kept live by control-start/end), so there's nothing to
		// restore per-mount — mcpHandler reads that shared set directly.

		// Fire parent UI callbacks for whichever tab the dock load() activated.
		const activeTab = tabManager.activeTab;
		if (activeTab) {
			if (onUrlChange) onUrlChange(activeTab.url);
			if (onUrlInputChange) onUrlInputChange(activeTab.url);
			if (onSessionChange) onSessionChange(activeTab.sessionId);
			if (onLoadingChange) onLoadingChange(false);
			if (onErrorChange) onErrorChange(null);
		}
	}

	return {
		// Managers
		tabManager,
		streamHandler,
		nativeUIHandler,
		mcpHandler,

		// Tab operations
		createNewTab,
		switchToTab,
		closeTab,

		// Browser operations
		launchBrowserForTab,
		navigateBrowserForTab,

		// Device control
		changeDeviceSize,
		toggleRotation,

		// Lifecycle
		initialize,
		cleanup,
		switchProject,

		// Utilities
		sendInteraction
	};
}

export type BrowserCoordinator = ReturnType<typeof createBrowserCoordinator>;
