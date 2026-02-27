<script lang="ts">
	import Toolbar from './components/Toolbar.svelte';
	import Container from './components/Container.svelte';
	import VirtualCursor from './components/VirtualCursor.svelte';
	import SelectDropdown from './components/SelectDropdown.svelte';
	import ContextMenu from './components/ContextMenu.svelte';
	import type { BrowserSelectInfo, BrowserContextMenuInfo } from '$frontend/lib/types/native-ui';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onMount, onDestroy } from 'svelte';
	import type { DeviceSize, Rotation } from '$frontend/lib/constants/preview';
	import { debug } from '$shared/utils/logger';
	import { createBrowserCoordinator } from './core/coordinator.svelte';
	import { sendScaleUpdate } from './core/interactions.svelte';
	import { projectState } from '$frontend/lib/stores/core/projects.svelte';

	let {
		url = $bindable(''),
		isOpen = $bindable(false),
		mode = $bindable<'split' | 'tab'>('split'),
		deviceSize = $bindable<DeviceSize>('laptop'),
		rotation = $bindable<Rotation>('portrait'),
		previewDimensions = $bindable<any>({ scale: 1 })
	} = $props();

	// Get projectId from project state (REQUIRED for project isolation)
	const projectId = $derived(projectState.currentProject?.id || '');

	// URL input state - separate from actual preview URL
	let urlInput = $state('');

	// UI state
	let isLoading = $state(false);
	let isLaunchingBrowser = $state(false);
	let isNavigating = $state(false);
	let isReconnecting = $state(false); // True during fast reconnect after navigation
	let sessionId = $state<string | null>(null);
	let sessionInfo = $state<any>(null);
	let isConnected = $state(false);
	let isStreamReady = $state(false);
	let errorMessage = $state<string | null>(null);
	let isConsoleOpen = $state(false); // Console temporarily disabled
	let consoleLogs = $state<any[]>([]);

	// Virtual cursors
	let virtualCursor = $state<{x: number, y: number, visible: boolean, clicking?: boolean}>({
		x: 0, y: 0, visible: false, clicking: false
	});
	let mcpVirtualCursor = $state<{x: number, y: number, visible: boolean, clicking?: boolean}>({
		x: 0, y: 0, visible: false, clicking: false
	});

	// Native UI state
	let currentSelectInfo = $state<BrowserSelectInfo | null>(null);
	let currentContextMenuInfo = $state<BrowserContextMenuInfo | null>(null);

	// Canvas and preview state
	let canvasAPI = $state<any>(null);
	let currentTabLastFrameData = $state<any>(null);

	// Flag to prevent URL watcher from double-launching during MCP session creation
	const mcpLaunchInProgress = $state(false);

	// Flag to track if sessions were recovered (prevents creating empty tab on mount)
	let sessionsRecovered = $state(false);

	// Create browser coordinator with projectId
	const coordinator = createBrowserCoordinator({
		projectId: () => projectId, // Pass projectId as getter function
		onUrlChange: (newUrl) => {
			url = newUrl;
		},
		onUrlInputChange: (newUrlInput) => {
			urlInput = newUrlInput;
		},
		onSessionChange: (newSessionId) => {
			sessionId = newSessionId;
		},
		onLoadingChange: (loading) => {
			isLoading = loading;
		},
		onErrorChange: (error) => {
			errorMessage = error;
		},
		onSessionsRecovered: (tabCount) => {
			debug.log('preview', `📦 Sessions recovered callback: ${tabCount} tabs`);
			sessionsRecovered = tabCount > 0;
		},
		onSelectOpen: (selectInfo) => {
			currentSelectInfo = selectInfo;
		},
		onContextMenuOpen: (menuInfo) => {
			currentContextMenuInfo = menuInfo;
		},
		onVirtualCursorUpdate: (x, y, clicking) => {
			virtualCursor = { x, y, visible: true, clicking: clicking || false };
			if (clicking) {
				setTimeout(() => {
					virtualCursor = { ...virtualCursor, clicking: false };
				}, 300);
			}
		},
		onVirtualCursorHide: () => {
			virtualCursor = { ...virtualCursor, visible: false };
		},
		onMcpCursorUpdate: (x, y, clicking) => {
			mcpVirtualCursor = { x, y, visible: true, clicking: clicking || false };
			if (clicking) {
				setTimeout(() => {
					mcpVirtualCursor = { ...mcpVirtualCursor, clicking: false };
				}, 300);
			}
		},
		onMcpCursorHide: () => {
			mcpVirtualCursor = { ...mcpVirtualCursor, visible: false };
		},
		transformBrowserToDisplayCoordinates: (browserX, browserY) => {
			return transformBrowserToDisplayCoordinates(browserX, browserY);
		}
	});

	const { tabManager, streamHandler, nativeUIHandler, mcpHandler } = coordinator;

	// Derived states from tab manager
	const tabs = $derived(tabManager.tabs);
	const activeTabId = $derived(tabManager.activeTabId);
	const activeTab = $derived(tabManager.activeTab);

	// Initialize - session recovery is handled inside coordinator.initialize()
	onMount(() => {
		coordinator.initialize();
		// Note: We don't create a new tab here anymore
		// The coordinator will either:
		// 1. Recover existing tabs from backend (after refresh)
		// 2. Or we create a new tab via the $effect below when isOpen is true and tabs.length === 0
	});

	// Cleanup
	onDestroy(async () => {
		await coordinator.cleanup();
	});

	// Watch for project changes and reload sessions
	let previousProjectId = '';
	let initialRecoveryDone = false;
	$effect(() => {
		const currentProjectId = projectId;

		// Initial recovery - trigger when projectId first becomes available after mount
		if (!initialRecoveryDone && currentProjectId && previousProjectId === '') {
			debug.log('preview', `🔄 Initial project loaded: ${currentProjectId}, triggering session recovery`);
			previousProjectId = currentProjectId;
			initialRecoveryDone = true;
			// Trigger recovery for initial project
			coordinator.switchProject();
			return;
		}

		// Project changed - switch to new project
		if (currentProjectId && currentProjectId !== previousProjectId && previousProjectId !== '') {
			debug.log('preview', `🔄 Project changed: ${previousProjectId} → ${currentProjectId}`);
			previousProjectId = currentProjectId;
			coordinator.switchProject();
		}
	});

	// Sync state from active tab
	$effect(() => {
		const tab = activeTab;
		if (tab) {
			url = tab.url;
			urlInput = tab.url;
			sessionId = tab.sessionId;
			sessionInfo = tab.sessionInfo;
			isConnected = tab.isConnected;
			isStreamReady = tab.isStreamReady;
			isLoading = tab.isLoading;
			isLaunchingBrowser = tab.isLaunchingBrowser;
			isNavigating = tab.isNavigating;
			errorMessage = tab.errorMessage;
			deviceSize = tab.deviceSize;
			rotation = tab.rotation;
			consoleLogs = tab.consoleLogs;
			canvasAPI = tab.canvasAPI;
			previewDimensions = tab.previewDimensions || { scale: 1 };
			currentTabLastFrameData = tab.lastFrameData;

			// Setup canvas after tab switch
			if (canvasAPI && canvasAPI.setupCanvas) {
				setTimeout(() => {
					canvasAPI.setupCanvas();
				}, 50);
			}
		}
	});

	// Create initial tab if opened and no tabs exist (and sessions weren't just recovered)
	$effect(() => {
		// Wait a bit for session recovery to complete before deciding to create empty tab
		// The recovery happens async in initialize(), so we need to give it time
		if (isOpen && tabs.length === 0 && !sessionsRecovered) {
			// Longer delay to ensure session recovery has time to complete
			// This prevents race condition where empty tab is created during restore
			const timeout = setTimeout(() => {
				// Double-check tabs.length after delay in case recovery happened
				// Only create tab if still no tabs and not currently restoring
				if (tabs.length === 0 && !sessionsRecovered) {
					debug.log('preview', '📝 No recovered sessions after wait, creating empty tab');
					coordinator.createNewTab('');
				} else {
					debug.log('preview', '📝 Tabs recovered during wait period, skipping empty tab creation');
				}
			}, 1000); // Increased from 500ms to 1000ms for safer delay
			return () => clearTimeout(timeout);
		}
	});

	// Watch for URL changes from parent (e.g., MCP integration)
	let previousUrl = '';
	$effect(() => {
		if (!url || url === previousUrl) return;
		if (mcpLaunchInProgress) {
			previousUrl = url;
			urlInput = url;
			return;
		}

		debug.log('preview', `📝 URL changed from parent: ${previousUrl} → ${url}`);
		previousUrl = url;
		urlInput = url;

		if (activeTabId) {
			const tab = activeTab;
			if (tab) {
				// Prevent duplicate launches - check if already launching or has session for this URL
				if (tab.isLaunchingBrowser) {
					debug.log('preview', `⏭️ Skipping launch - already launching browser for ${activeTabId}`);
					return;
				}

				// If URL hasn't changed from tab's URL, don't re-launch
				if (tab.url === url && tab.sessionId) {
					debug.log('preview', `⏭️ Skipping launch - URL unchanged and session exists`);
					return;
				}

				tabManager.updateTab(activeTabId, {
					url: url,
					errorMessage: null
				});

				if (tab.sessionId) {
					coordinator.navigateBrowserForTab(activeTabId, url);
				} else {
					coordinator.launchBrowserForTab(activeTabId, url);
				}
			}
		} else {
			coordinator.createNewTab(url);
		}
	});

	// Store canvasAPI and previewDimensions in active tab
	$effect(() => {
		if (activeTabId && activeTab) {
			const updates: any = {};
			let needsUpdate = false;

			if (canvasAPI && activeTab.canvasAPI !== canvasAPI) {
				updates.canvasAPI = canvasAPI;
				needsUpdate = true;
			}

			if (previewDimensions && JSON.stringify(activeTab.previewDimensions) !== JSON.stringify(previewDimensions)) {
				updates.previewDimensions = previewDimensions;
				needsUpdate = true;
			}

			if (needsUpdate) {
				tabManager.updateTab(activeTabId, updates);
			}
		}
	});

	// Sync isStreamReady back to active tab
	$effect(() => {
		if (activeTabId && activeTab && activeTab.isStreamReady !== isStreamReady) {
			tabManager.updateTab(activeTabId, { isStreamReady });
		}
	});

	// Watch scale changes and send to backend
	let lastSentScale = 1;
	$effect(() => {
		const currentScale = previewDimensions?.scale || 1;
		if (currentScale !== lastSentScale && sessionId && isStreamReady) {
			debug.log('preview', `📐 Scale changed to ${currentScale}, sending to backend`);
			sendScaleUpdate(currentScale);
			lastSentScale = currentScale;
		}
	});

	// Initialize URL input
	$effect(() => {
		if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
			url = 'http://' + url;
		}
		if (url && !urlInput) {
			urlInput = url;
		}
	});

	// URL handling functions
	function handleGoClick() {
		if (!urlInput.trim()) return;

		let processedUrl = urlInput.trim();
		if (!processedUrl.startsWith('http://') && !processedUrl.startsWith('https://')) {
			processedUrl = 'http://' + processedUrl;
		}

		if (!activeTabId) {
			coordinator.createNewTab(processedUrl);
		} else {
			const tab = activeTab;
			if (tab) {
				tabManager.updateTab(activeTabId, {
					url: processedUrl,
					errorMessage: null
				});

				if (tab.sessionId) {
					coordinator.navigateBrowserForTab(activeTabId, processedUrl);
				} else {
					coordinator.launchBrowserForTab(activeTabId, processedUrl);
				}
			}
		}
	}

	function refreshPreview() {
		if (!activeTabId) return;
		const tab = activeTab;
		if (tab && tab.sessionId && tab.url) {
			coordinator.navigateBrowserForTab(activeTabId, tab.url);
		}
	}

	async function closePreview() {
		if (activeTabId && tabs.length > 0) {
			coordinator.closeTab(activeTabId);
			if (tabs.length === 0) {
				isOpen = false;
			}
		} else {
			isOpen = false;
		}
	}

	function handleCanvasInteraction(action: any) {
		const tab = activeTab;
		if (tab && tab.sessionId) {
			coordinator.sendInteraction(action);
		}
	}

	function transformBrowserToDisplayCoordinates(browserX: number, browserY: number): { x: number, y: number } | null {
		let canvasElement: HTMLCanvasElement | null = null;

		// Try to get canvas element from canvasAPI first (preferred method)
		if (canvasAPI && canvasAPI.getCanvasElement) {
			canvasElement = canvasAPI.getCanvasElement();
		}

		// Fallback: Try to get canvas element directly from DOM if canvasAPI not ready yet
		// This handles race condition where context menu event arrives before canvasAPI is set
		if (!canvasElement && typeof document !== 'undefined') {
			// Canvas is rendered inside Container component
			const foundCanvas = document.querySelector('canvas[tabindex="0"]') as HTMLCanvasElement;
			if (foundCanvas) {
				canvasElement = foundCanvas;
				debug.log('preview', `Using fallback DOM query to get canvas element`);
			}
		}

		if (!canvasElement) {
			debug.warn('preview', `Transform coordinates failed: canvasElement not found (browser: ${browserX}, ${browserY})`);
			return null;
		}

		try {
			const canvasRect = canvasElement.getBoundingClientRect();
			const scaleX = canvasRect.width / canvasElement.width;
			const scaleY = canvasRect.height / canvasElement.height;
			const screenX = canvasRect.left + (browserX * scaleX);
			const screenY = canvasRect.top + (browserY * scaleY);

			return { x: screenX, y: screenY };
		} catch (error) {
			debug.error('preview', 'Error transforming coordinates:', error);
			return null;
		}
	}

	async function handleSelectOption(selectedIndex: number) {
		if (!currentSelectInfo) return;
		await nativeUIHandler.respondSelectOption(currentSelectInfo, selectedIndex);
		currentSelectInfo = null;
	}

	function closeSelectDropdown() {
		currentSelectInfo = null;
	}

	async function handleContextMenuItem(itemId: string) {
		if (!currentContextMenuInfo) return;
		const menuInfo = currentContextMenuInfo;
		currentContextMenuInfo = null;
		await nativeUIHandler.respondContextMenuItem(menuInfo, itemId);
	}

	function closeContextMenu() {
		currentContextMenuInfo = null;
	}

	function isCurrentTabMcpControlled(): boolean {
		return mcpHandler.isCurrentTabMcpControlled();
	}

	// Stream message handling
	$effect(() => {
		if (activeTabId && sessionId) {
			// Message handling is done via coordinator
		}
	});

	// Expose methods for parent (PreviewPanel)
	export const browserActions = {
		changeDeviceSize: (size: DeviceSize) => {
			coordinator.changeDeviceSize(size, previewDimensions?.scale);
		},
		toggleRotation: () => {
			coordinator.toggleRotation(previewDimensions?.scale);
		},
		getSessionInfo: () => sessionInfo,
		getIsStreamReady: () => isStreamReady,
		getErrorMessage: () => errorMessage
	};
</script>

{#if isOpen && mode === 'split'}
	<div
		class="h-full flex flex-col theme-transition bg-slate-50 dark:bg-slate-900 dot-pattern"
		in:fly={{ x: 300, duration: 300, easing: cubicOut }}
		out:fly={{ x: 300, duration: 250, easing: cubicOut }}
	>
		<!-- Preview Toolbar -->
		<Toolbar
			bind:url
			bind:urlInput
			bind:isLoading
			bind:isLaunchingBrowser
			bind:isNavigating
			bind:isReconnecting
			bind:sessionId
			bind:sessionInfo
			bind:isConnected
			bind:isStreamReady
			bind:errorMessage
			bind:isConsoleOpen
			{tabs}
			{activeTabId}
			mcpControlledTabId={mcpHandler.mcpControlState.controlledTabId}
			onGoClick={handleGoClick}
			onRefresh={refreshPreview}
			onOpenInExternalBrowser={() => {}}
			onClosePreview={closePreview}
			onToggleConsole={() => {}}
			onUrlInput={() => {}}
			onUrlKeydown={() => {}}
			onSwitchTab={(tabId: string) => coordinator.switchToTab(tabId)}
			onCloseTab={(tabId: string) => coordinator.closeTab(tabId)}
			onNewTab={() => coordinator.createNewTab()}
		/>

		<!-- Preview Container -->
		<div class="flex-1 flex min-h-0">
			<Container
				projectId={projectId}
				bind:url
				bind:isLoading
				bind:isLaunchingBrowser
				bind:isNavigating
				bind:isReconnecting
				bind:deviceSize
				bind:rotation
				bind:sessionId
				bind:sessionInfo
				bind:isConnected
				bind:isStreamReady
				bind:errorMessage
				bind:virtualCursor
				bind:canvasAPI
				bind:previewDimensions
				bind:lastFrameData={currentTabLastFrameData}
				isMcpControlled={isCurrentTabMcpControlled()}
				onInteraction={handleCanvasInteraction}
				onRetry={handleGoClick}
			/>
		</div>

		<!-- Virtual Cursor - User -->
		{#if !isCurrentTabMcpControlled()}
			<VirtualCursor cursor={virtualCursor} />
		{/if}

		<!-- MCP Virtual Cursor -->
		{#if mcpHandler.mcpControlState.isControlled}
			<VirtualCursor cursor={mcpVirtualCursor} />
		{/if}

		<!-- Native UI Overlays -->
		<SelectDropdown
			bind:selectInfo={currentSelectInfo}
			onSelect={handleSelectOption}
			onClose={closeSelectDropdown}
		/>

		<ContextMenu
			bind:menuInfo={currentContextMenuInfo}
			onSelectItem={handleContextMenuItem}
			onClose={closeContextMenu}
		/>
	</div>
{/if}

<style>
	/* Dot Pattern Background */
	.dot-pattern {
		background: center center / 1.5rem repeat transparent;
		/* Light mode: darker dots */
		background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg%20width%3D'30'%20height%3D'30'%20fill%3D'none'%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%3E%3Cpath%20d%3D'M1.227%200c.687%200%201.227.54%201.227%201.227s-.54%201.227-1.227%201.227S0%201.914%200%201.227.54%200%201.227%200z'%20fill%3D'rgba(0%2C0%2C0%2C0.25)'%2F%3E%3C%2Fsvg%3E");
	}

	/* Dark mode: lighter dots */
	:global(.dark) .dot-pattern {
		background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg%20width%3D'30'%20height%3D'30'%20fill%3D'none'%20xmlns%3D'http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%3E%3Cpath%20d%3D'M1.227%200c.687%200%201.227.54%201.227%201.227s-.54%201.227-1.227%201.227S0%201.914%200%201.227.54%200%201.227%200z'%20fill%3D'rgba(255%2C255%2C255%2C0.15)'%2F%3E%3C%2Fsvg%3E");
	}
</style>
