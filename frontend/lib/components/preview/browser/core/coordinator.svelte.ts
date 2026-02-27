/**
 * Browser Coordinator
 * Coordinates all browser preview services and state management
 */

import { debug } from '$shared/utils/logger';
import type { DeviceSize, Rotation } from '$frontend/lib/constants/preview';
import { createTabManager, type TabManager, type PreviewTab, getTabTitle } from './tab-manager.svelte';
import { createStreamMessageHandler, type StreamMessageHandler } from './stream-handler.svelte';
import { createNativeUIHandler, type NativeUIHandler } from './native-ui-handlers.svelte';
import { createMcpHandler, type McpHandler } from './mcp-handlers.svelte';
import {
	launchBrowser as launchBrowserOp,
	navigateBrowser as navigateBrowserOp,
	destroyBrowser,
	destroyBrowserTab,
	getExistingTabs,
	switchToBackendTab,
	type ExistingTabInfo
} from './tab-operations.svelte';
import { browserCleanup } from './cleanup.svelte';
import { sendInteraction, updateViewport, setInteractionProjectId } from './interactions.svelte';
import type { BrowserSelectInfo, BrowserContextMenuInfo } from '$frontend/lib/types/native-ui';

export interface BrowserCoordinatorConfig {
	// Project ID getter (REQUIRED for project isolation)
	projectId: () => string;

	// Callbacks from parent component
	onUrlChange?: (url: string) => void;
	onUrlInputChange?: (urlInput: string) => void;
	onSessionChange?: (sessionId: string | null) => void;
	onLoadingChange?: (isLoading: boolean) => void;
	onErrorChange?: (errorMessage: string | null) => void;

	// Session recovery callback - called when sessions are recovered after page refresh
	onSessionsRecovered?: (tabCount: number) => void;

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
		onSessionsRecovered,
		onSelectOpen,
		onContextMenuOpen,
		onVirtualCursorUpdate,
		onVirtualCursorHide,
		onMcpCursorUpdate,
		onMcpCursorHide,
		transformBrowserToDisplayCoordinates
	} = config;

	// Restore lock to prevent race conditions
	let isRestoring = $state(false);
	let eventListenersReady = $state(false);

	// Create managers
	const tabManager = createTabManager();

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
			const result = await navigateBrowserOp(newUrl, projectId);

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
		// Prevent creating tabs during restore to avoid race conditions
		if (isRestoring) {
			debug.warn('preview', '⚠️ Cannot create tab while restoring sessions');
			return '';
		}

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
		browserCleanup.initialize();
		nativeUIHandler.setupEventListeners();
		mcpHandler.setupEventListeners();

		// CRITICAL: Setup event listeners FIRST before any recovery
		// This ensures we don't miss events from backend
		setupTabEventListeners();
		setupNavigationListeners();

		// Mark event listeners as ready
		eventListenersReady = true;

		// Note: setInteractionProjectId and recoverExistingSessions are called by switchProject()
		// which is triggered by the project watcher effect after projectId becomes available
	}

	/**
	 * Recover existing browser sessions from backend (after page refresh)
	 */
	async function recoverExistingSessions() {
		// Wait for event listeners to be ready before recovering
		// This prevents missing events from backend during recovery
		if (!eventListenersReady) {
			debug.warn('preview', '⚠️ Event listeners not ready, waiting...');
			await new Promise(resolve => {
				const checkInterval = setInterval(() => {
					if (eventListenersReady) {
						clearInterval(checkInterval);
						resolve(true);
					}
				}, 50);
			});
		}

		// Set restore lock to prevent race conditions
		isRestoring = true;

		try {
			const projectId = getProjectId();
			const existingTabs = await getExistingTabs(projectId);

			if (!existingTabs || existingTabs.count === 0) {
				debug.log('preview', '📭 No existing sessions to recover');
				isRestoring = false;
				return;
			}

			// Track which frontend tab corresponds to the active tab
			let activeTabFrontendId: string | null = null;
			let totalRestored = 0;

			// Restore backend tabs
			debug.log('preview', `🔄 Recovering ${existingTabs.count} existing browser sessions...`);

			for (const backendTab of existingTabs.tabs) {
				const frontendId = restoreTabFromBackend(backendTab, backendTab.isActive);

				// Register session for cleanup tracking
				browserCleanup.registerSession(backendTab.tabId);

				// Remember which frontend tab should be active
				if (backendTab.isActive && frontendId) {
					activeTabFrontendId = frontendId;
				}
				totalRestored++;
			}

			// Now switch to the active tab (after all tabs are restored)
			if (activeTabFrontendId) {
				debug.log('preview', `🎯 Switching to active tab: ${activeTabFrontendId}`);
				tabManager.switchTab(activeTabFrontendId);

				// If active tab has a backend session, notify backend
				const activeTab = tabManager.getTab(activeTabFrontendId);
				if (activeTab?.sessionId) {
					await switchToBackendTab(activeTab.sessionId, projectId);
				}

				// Update parent state with active tab info
				if (activeTab) {
					if (onUrlChange) onUrlChange(activeTab.url);
					if (onUrlInputChange) onUrlInputChange(activeTab.url);
					if (onSessionChange) onSessionChange(activeTab.sessionId);
					if (onLoadingChange) onLoadingChange(false);
					if (onErrorChange) onErrorChange(null);
				}
			}

			debug.log('preview', `✅ Session recovery complete - restored ${totalRestored} tabs`);

			// Notify parent that sessions were recovered
			if (onSessionsRecovered) {
				onSessionsRecovered(totalRestored);
			}
		} catch (error) {
			debug.error('preview', '❌ Error recovering sessions:', error);
		} finally {
			// Always release restore lock
			isRestoring = false;
		}
	}

	/**
	 * Restore a single tab from backend session
	 * Returns the frontend tab ID for this restored tab
	 */
	function restoreTabFromBackend(backendTab: ExistingTabInfo, isActive: boolean): string {
		debug.log('preview', `🔧 Restoring tab: ${backendTab.tabId} (${backendTab.url})`);

		// Create frontend tab matching backend tab
		const frontendTabId = tabManager.createTab(backendTab.url);

		// Update tab with backend session info
		tabManager.updateTab(frontendTabId, {
			sessionId: backendTab.tabId,
			sessionInfo: {
				quality: backendTab.quality,
				url: backendTab.url,
				deviceSize: backendTab.deviceSize as DeviceSize,
				rotation: backendTab.rotation as Rotation
			},
			url: backendTab.url,
			title: backendTab.title || getTabTitle(backendTab.url),
			deviceSize: backendTab.deviceSize as DeviceSize,
			rotation: backendTab.rotation as Rotation,
			isConnected: true,
			isStreamReady: false, // Will be set true when stream reconnects
			isLoading: false,
			isLaunchingBrowser: false,
			isNavigating: false,
			errorMessage: null
		});

		debug.log('preview', `✅ Tab restored: ${frontendTabId} → ${backendTab.tabId}`);

		return frontendTabId;
	}

	/**
	 * Setup tab event listeners
	 * CRITICAL: This must be synchronous to ensure listeners are ready before recovery
	 */
	function setupTabEventListeners() {
		debug.log('preview', '🎧 Setting up tab event listeners...');

		// Import ws synchronously (should already be loaded in app context)
		// This is critical to ensure listeners are ready before any events arrive
		import('$frontend/lib/utils/ws').then(({ default: ws }) => {
			debug.log('preview', '✅ WebSocket module loaded, registering tab event listeners');

			// Listen for tab opened events (from MCP or backend)
			ws.on('preview:browser-tab-opened', (data: any) => {
				debug.log('preview', `📥 Frontend received preview:browser-tab-opened:`, data);

				// Skip if we're currently restoring to prevent conflicts
				if (isRestoring) {
					debug.log('preview', `⏭️ Skipping tab-opened event during restore: ${data.tabId}`);
					return;
				}

				// Check if this tab already exists in frontend (by backend sessionId)
				const existingTab = tabManager.tabs.find(t => t.sessionId === data.tabId);
				if (existingTab) {
					debug.log('preview', `✓ Backend tab ${data.tabId} already linked to frontend tab ${existingTab.id}, skipping`);
					return;
				}

				// Check if there's a tab currently launching without sessionId (race condition fix)
				const launchingTab = tabManager.tabs.find(t => t.isLaunchingBrowser && !t.sessionId);
				if (launchingTab) {
					debug.log('preview', `🔗 Found launching tab ${launchingTab.id}, linking to backend tab ${data.tabId}`);

					// Update the launching tab with backend session info
					tabManager.updateTab(launchingTab.id, {
						sessionId: data.tabId,
						sessionInfo: {
							quality: 'good',
							url: data.url,
							deviceSize: data.deviceSize,
							rotation: data.rotation
						},
						url: data.url,
						title: data.title,
						deviceSize: data.deviceSize || 'laptop',
						rotation: data.rotation || 'landscape',
						isConnected: true,
						isStreamReady: false,
						isLoading: false,
						errorMessage: null
					});

					// Note: Session registration is handled by launchBrowserForTab
					debug.log('preview', `✅ Launching tab updated: ${launchingTab.id} → backend tab: ${data.tabId}`);
					return;
				}

				// Create frontend tab to match backend tab (only if no launching tab found)
				const frontendTabId = tabManager.createTab(data.url);

				// Update tab with backend session info including device settings
				tabManager.updateTab(frontendTabId, {
					sessionId: data.tabId, // Backend tab ID is the session ID
					sessionInfo: {
						quality: 'good',
						url: data.url,
						deviceSize: data.deviceSize,
						rotation: data.rotation
					},
					url: data.url,
					title: data.title,
					deviceSize: data.deviceSize || 'laptop',
					rotation: data.rotation || 'landscape',
					isConnected: true,
					isStreamReady: false,
					isLoading: false,
					errorMessage: null
				});

				// Register session for cleanup tracking
				browserCleanup.registerSession(data.tabId);

				// Switch to this tab if it's active
				if (data.isActive) {
					tabManager.switchTab(frontendTabId);
				}

				debug.log('preview', `✅ Frontend tab created: ${frontendTabId} → backend tab: ${data.tabId}`);
			});

			// Listen for tab closed events
			ws.on('preview:browser-tab-closed', (data) => {
				debug.log('preview', `📥 Frontend received preview:browser-tab-closed:`, data);

				// Find frontend tab by backend session ID
				const tab = tabManager.tabs.find(t => t.sessionId === data.tabId);
				if (tab) {
					tabManager.closeTab(tab.id);
					browserCleanup.unregisterSession(data.tabId);
					debug.log('preview', `✅ Frontend tab closed: ${tab.id}`);
				}
			});

			// Listen for tab switched events
			ws.on('preview:browser-tab-switched', (data) => {
				debug.log('preview', `📥 Frontend received preview:browser-tab-switched:`, data);

				// Find frontend tab by backend session ID
				const tab = tabManager.tabs.find(t => t.sessionId === data.newTabId);
				if (tab) {
					tabManager.switchTab(tab.id);
					debug.log('preview', `✅ Frontend switched to tab: ${tab.id}`);
				}
			});

			// Listen for viewport changed events
			ws.on('preview:browser-viewport-changed' as any, (data: any) => {
				debug.log('preview', `📥 Frontend received preview:browser-viewport-changed:`, data);

				// Find frontend tab by backend session ID
				const tab = tabManager.tabs.find(t => t.sessionId === data.tabId);
				if (tab) {
					// Update tab with new device settings
					tabManager.updateTab(tab.id, {
						deviceSize: data.deviceSize,
						rotation: data.rotation
					});
					debug.log('preview', `✅ Frontend viewport updated: ${tab.id} → ${data.deviceSize} (${data.rotation})`);
				}
			});

			debug.log('preview', `🎉 All tab event listeners registered and active`);
		}).catch(error => {
			debug.error('preview', '❌ Failed to setup tab event listeners:', error);
		});
	}

	/**
	 * Setup navigation event listeners
	 */
	function setupNavigationListeners() {
		// Import ws at runtime to avoid circular dependencies
		import('$frontend/lib/utils/ws').then(({ default: ws }) => {
			// Listen for navigation loading events
			ws.on('preview:browser-navigation-loading', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
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
			ws.on('preview:browser-navigation', (data: { sessionId: string; type: string; url: string; timestamp: number }) => {
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
		// Just clear frontend tracking - don't destroy backend sessions
		// Backend sessions will be recovered on next page load
		browserCleanup.clearAll();
		debug.log('preview', '🧹 Frontend cleanup complete (backend sessions preserved)');
	}

	/**
	 * Switch to a different project
	 * Clears current tabs and loads sessions from the new project
	 */
	async function switchProject() {
		const newProjectId = getProjectId();
		debug.log('preview', `🔄 Switching to project: ${newProjectId}`);

		// Set restore lock during project switch
		isRestoring = true;

		try {
			// Update projectId for interactions
			setInteractionProjectId(newProjectId);

			// Clear all local tabs
			tabManager.clearAllTabs();

			// Clear frontend tracking
			browserCleanup.clearAll();

			// Recover sessions from new project
			// Note: recoverExistingSessions will handle its own lock
			isRestoring = false;
			await recoverExistingSessions();
		} catch (error) {
			debug.error('preview', '❌ Error switching project:', error);
			isRestoring = false;
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
