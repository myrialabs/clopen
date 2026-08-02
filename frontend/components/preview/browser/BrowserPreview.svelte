<script lang="ts">
	import Toolbar from './components/Toolbar.svelte';
	import Container from './components/Container.svelte';
	import SelectDropdown from './components/SelectDropdown.svelte';
	import ContextMenu from './components/ContextMenu.svelte';
	import NativePicker from './components/NativePicker.svelte';
	import ConsolePanel from './components/ConsolePanel.svelte';
	import DialogOverlay from './components/DialogOverlay.svelte';
	import PermissionPrompt from './components/PermissionPrompt.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import type {
		BrowserSelectInfo,
		BrowserContextMenuInfo,
		BrowserConsoleMessage,
		BrowserDialogEvent,
		BrowserNativePickerInfo,
		PendingPermission
	} from '$frontend/utils/native-ui';
	import { fly } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { onMount, onDestroy } from 'svelte';
	import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';
	import { debug } from '$shared/utils/logger';
	import { createBrowserCoordinator } from './core/coordinator.svelte';
	import { setDisplayScale, goHistory } from './core/interactions.svelte';
	import { previewHostBridge } from '$frontend/services/preview/browser/host-bridge.service';
	import { browserConsoleService } from '$frontend/services/preview/browser/browser-console.service';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';

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
	let isConsoleOpen = $state(false);
	let consoleDock = $state<'bottom' | 'right'>('bottom');
	let consoleHeight = $state(240);
	let consoleWidth = $state(380);
	/** Panel width, which decides whether the console may dock to the side. */
	let panelWidth = $state(0);
	let consoleLogs = $state<BrowserConsoleMessage[]>([]);

	// Navigation affordances, pushed by the backend after every navigation
	let canGoBack = $state(false);
	let canGoForward = $state(false);

	/**
	 * Native UI answered by the viewer, keyed by the backend tab that raised it.
	 *
	 * A dialog or permission prompt belongs to one page. Holding a single global
	 * slot meant a prompt raised by tab 1 followed the user to tab 2 and appeared
	 * to be asking on that page's behalf — and answering it there granted access
	 * to a page they were not looking at. Pending requests now stay with their
	 * tab and reappear when the user returns to it.
	 */
	let dialogsByTab = $state<Record<string, BrowserDialogEvent>>({});
	let permissionsByTab = $state<Record<string, PendingPermission[]>>({});
	let pendingFilePick = $state<PendingPermission | null>(null);
	let filePickerElement = $state<HTMLInputElement | undefined>();

	const currentDialog = $derived(sessionId ? (dialogsByTab[sessionId] ?? null) : null);
	const pendingPermission = $derived(
		sessionId ? (permissionsByTab[sessionId]?.[0] ?? null) : null
	);

	function queuePermission(request: PendingPermission) {
		const queue = permissionsByTab[request.tabId] ?? [];
		permissionsByTab = { ...permissionsByTab, [request.tabId]: [...queue, request] };
	}

	function dequeuePermission(request: PendingPermission) {
		const queue = (permissionsByTab[request.tabId] ?? []).filter(
			(entry) => entry.requestId !== request.requestId
		);
		permissionsByTab = { ...permissionsByTab, [request.tabId]: queue };
	}

	// Bounds the context menu and select popup are kept inside
	let panelElement = $state<HTMLDivElement | undefined>();
	let panelBounds = $state<DOMRect | null>(null);

	let isMobile = $state(false);

	/** Errors and warnings drive the badge on the console button. */
	const consoleIssueCount = $derived(
		consoleLogs.reduce(
			(total, entry) =>
				entry.type === 'error' || entry.type === 'warn' ? total + (entry.count ?? 1) : total,
			0
		)
	);

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
	let currentNativePicker = $state<BrowserNativePickerInfo | null>(null);

	// Canvas and preview state
	let canvasAPI = $state<any>(null);
	let currentTabLastFrameData = $state<any>(null);
	let toolbarRef = $state<any>(null);

	// Flag to prevent URL watcher from double-launching during MCP session creation
	const mcpLaunchInProgress = $state(false);

	// Touch interaction mode for canvas
	let touchMode = $state<'scroll' | 'cursor'>('scroll');

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
		onSelectOpen: (selectInfo) => {
			refreshPanelBounds();
			currentSelectInfo = selectInfo;
		},
		onContextMenuOpen: (menuInfo) => {
			refreshPanelBounds();
			currentContextMenuInfo = menuInfo;
		},
		onNativePickerOpen: (picker) => {
			refreshPanelBounds();
			currentNativePicker = picker;
		},
		onDialogOpen: (dialogEvent) => {
			dialogsByTab = { ...dialogsByTab, [dialogEvent.sessionId]: dialogEvent };
		},
		onDialogClose: (closed) => {
			if (!closed) return;
			// Keyed by dialog id as well as tab: a stale close must not clear a
			// second dialog the page raised straight after the first.
			const current = dialogsByTab[closed.sessionId];
			if (!current || current.dialogId !== closed.dialogId) return;

			const next = { ...dialogsByTab };
			delete next[closed.sessionId];
			dialogsByTab = next;
		},
		onOpenInspector: () => {
			isConsoleOpen = true;
		},
		onOpenUrlInHostBrowser: (targetUrl) => {
			window.open(targetUrl, '_blank', 'noopener');
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

	// Initialize event listeners. Tab recovery itself is driven by the
	// preview-tabs dock's load() inside the workspace switch barrier — we just
	// adopt the singleton state below.
	let stopHostBridge: (() => void) | null = null;

	onMount(() => {
		coordinator.initialize();

		const syncLayout = () => {
			isMobile = window.innerWidth < 1024;
			const rect = panelElement?.getBoundingClientRect() ?? null;
			panelBounds = rect;
			panelWidth = rect?.width ?? 0;
		};
		syncLayout();
		window.addEventListener('resize', syncLayout);

		// The panel is resizable independently of the window, so its own width has
		// to be observed rather than inferred from the viewport.
		const observer =
			typeof ResizeObserver !== 'undefined'
				? new ResizeObserver((entries) => {
						for (const entry of entries) panelWidth = entry.contentRect.width;
					})
				: null;
		if (panelElement && observer) observer.observe(panelElement);

		// The bridge answers the page's requests for the viewer's own devices, so
		// it lives for as long as the panel is mounted rather than per tab.
		stopHostBridge = previewHostBridge.start({
			onPermissionRequest: (request) => {
				queuePermission(request);
			},
			onFilePickRequest: (request) => {
				// Routed through the same prompt as the other capabilities rather
				// than opening the picker straight away: browsers only raise a file
				// dialog for a page that just received a user gesture, and a
				// WebSocket event is not one. The Choose button supplies it.
				pendingFilePick = request;
				queuePermission(request);
			},
			onRequestSettled: ({ tabId, requestId }) => {
				// Answered somewhere — possibly on another device. The page has its
				// answer either way, so this prompt is now asking about nothing.
				const queue = permissionsByTab[tabId];
				if (queue?.some((entry) => entry.requestId === requestId)) {
					permissionsByTab = {
						...permissionsByTab,
						[tabId]: queue.filter((entry) => entry.requestId !== requestId)
					};
				}
				if (pendingFilePick?.requestId === requestId) pendingFilePick = null;
			},
			onDownload: (event) => {
				if (event.state === 'failed') {
					addNotification({
						type: 'error',
						title: 'Download failed',
						message: event.error || `Could not download ${event.filename}`
					});
				} else if (event.state === 'completed') {
					addNotification({
						type: 'success',
						title: 'Download ready',
						message: `${event.filename} was saved to your device`
					});
				}
			},
			getTabOrigin: (tabId) => {
				const tab = tabManager.tabs.find((entry) => entry.sessionId === tabId);
				try {
					return new URL(tab?.url ?? url).origin;
				} catch {
					return tab?.url || 'This page';
				}
			}
		});

		return () => {
			window.removeEventListener('resize', syncLayout);
			observer?.disconnect();
		};
	});

	// Cleanup
	onDestroy(async () => {
		stopHostBridge?.();
		stopHostBridge = null;
		await coordinator.cleanup();
	});

	// Transient overlays belong to the page that raised them, so a tab switch
	// dismisses them rather than leaving a menu pointing at content that is no
	// longer on screen. Dialogs and permissions are queued per tab instead.
	let lastOverlayTabId: string | null = null;
	$effect(() => {
		if (sessionId === lastOverlayTabId) return;
		lastOverlayTabId = sessionId;
		currentSelectInfo = null;
		currentContextMenuInfo = null;
		currentNativePicker = null;
	});

	/** Bounds are only read when a popup opens, so refreshing then is enough. */
	function refreshPanelBounds() {
		panelBounds = panelElement?.getBoundingClientRect() ?? null;
	}

	// Watch for project changes and reload sessions.
	//
	// Bail while a workspace switch is in flight: the singleton tabManager is
	// mid clear/restore/load during that window and adopting it now would race
	// with the dock — observed as a spurious "New Tab" or duplicated/cross-
	// project tabs once load() completes. Once the barrier drops, isSwitching
	// flips and the effect re-runs against the authoritative state.
	let previousProjectId = '';
	let initialRecoveryDone = false;
	$effect(() => {
		const currentProjectId = projectId;
		if (appState.isSwitching) return;

		// Initial recovery - trigger when projectId first becomes available after mount
		if (!initialRecoveryDone && currentProjectId && previousProjectId === '') {
			debug.log('preview', `🔄 Initial project loaded: ${currentProjectId}, adopting recovered tabs`);
			previousProjectId = currentProjectId;
			initialRecoveryDone = true;
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

	/**
	 * Address-bar ownership.
	 *
	 * The sync effect below re-runs on *any* tab mutation — a console line, a
	 * stream flag — because `updateTab` replaces the tab object. Writing
	 * `urlInput` unconditionally therefore wiped whatever was being typed, and
	 * clearing the field brought the old URL straight back. So the field is only
	 * refilled when the tab's URL genuinely changed, and never while the user has
	 * the address bar focused.
	 */
	let lastSyncedUrl = $state<string | null>(null);
	let lastSyncedTabId = $state<string | null>(null);
	let isEditingAddress = $state(false);

	// Sync state from active tab
	$effect(() => {
		const tab = activeTab;
		if (tab) {
			url = tab.url;

			// A tab switch always adopts the new tab's URL: a half-typed address
			// belongs to the tab it was typed in.
			const switchedTab = tab.id !== lastSyncedTabId;
			if (switchedTab || tab.url !== lastSyncedUrl) {
				lastSyncedTabId = tab.id;
				lastSyncedUrl = tab.url;
				if (switchedTab || !isEditingAddress) urlInput = tab.url;
			}
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
			canGoBack = tab.canGoBack;
			canGoForward = tab.canGoForward;
			// Only ever adopted, never cleared. There is a single Canvas instance
			// behind every tab, and it publishes its API once on mount — so
			// overwriting this with a tab that has no copy stored yet left the
			// panel with no canvas API at all, and nothing to re-publish it.
			// Everything that maps page coordinates to the screen goes through it,
			// which is why select popups and pickers stopped appearing after a
			// tab switch ("coordinate transformation failed").
			if (tab.canvasAPI) canvasAPI = tab.canvasAPI;
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

	// Watch for URL changes from parent (e.g., MCP integration)
	let previousUrl = '';
	$effect(() => {
		if (!url || url === previousUrl) return;
		// Ignore browser-internal error pages (e.g. DNS failure) — they are not real URLs
		// and should never trigger a new navigation attempt.
		if (url.startsWith('chrome-error://') || url.startsWith('chrome://')) {
			previousUrl = url;
			return;
		}
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

	// Sync isNavigating back to active tab (Canvas resets this on first frame after navigation)
	$effect(() => {
		if (activeTabId && activeTab && activeTab.isNavigating !== isNavigating) {
			tabManager.updateTab(activeTabId, { isNavigating });
		}
	});

	// Watch scale changes and send to backend.
	// Capture resolution follows the displayed size, so a resize needs the new
	// metrics — but not a capture restart, which is what sendScaleUpdate does
	// and is reserved for recovering a stuck stream.
	let lastSentScale = 1;
	$effect(() => {
		const currentScale = previewDimensions?.scale || 1;
		if (currentScale !== lastSentScale && sessionId && isStreamReady) {
			debug.log('preview', `📐 Scale changed to ${currentScale}, sending to backend`);
			setDisplayScale(currentScale);
			canvasAPI?.sendDisplayMetrics?.();
			lastSentScale = currentScale;
		}
	});

	// Initialize URL input
	$effect(() => {
		if (url && !url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
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
		if (!processedUrl.startsWith('http://') && !processedUrl.startsWith('https://') && !processedUrl.startsWith('file://')) {
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

	/**
	 * Stop loading.
	 *
	 * Halts the page's own load via `window.stop()`, then clears the local
	 * loading flags — Puppeteer offers no cancel for an in-flight `goto`, so the
	 * indicator has to be released here rather than waiting for it to settle.
	 */
	function stopLoading() {
		if (!activeTabId) return;

		const tab = activeTab;
		if (tab?.sessionId) {
			coordinator.sendInteraction({ type: 'stop' });
		}

		tabManager.updateTab(activeTabId, {
			isLoading: false,
			isNavigating: false,
			isLaunchingBrowser: false
		});
		isLoading = false;
		isNavigating = false;
		isReconnecting = false;
	}

	async function navigateHistory(direction: 'back' | 'forward') {
		const tab = activeTab;
		if (!tab?.sessionId) return;

		// Optimistic: the arrow greys out immediately, then the authoritative
		// state arrives with the tab-meta push once the entry commits.
		if (activeTabId) {
			tabManager.updateTab(activeTabId, { isNavigating: true });
		}
		await goHistory(direction, tab.sessionId);
	}

	function handleDialogResponse(accept: boolean, promptText?: string) {
		const dialog = currentDialog;
		if (!dialog) return;

		// The overlay is dismissed by the resulting `onDialogClose`, which is the
		// same path every other viewer of this tab takes.
		nativeUIHandler.respondToDialog(dialog, accept, promptText);
	}

	function handlePermissionAllow(request: PendingPermission) {
		dequeuePermission(request);

		if (request.kind === 'file-pick') {
			if (!filePickerElement) return;
			// Reset first: re-picking the same file fires no change event otherwise.
			filePickerElement.value = '';
			filePickerElement.multiple = !!request.payload?.multiple;
			filePickerElement.click();
			return;
		}

		// Not awaited: the device API must run inside this click's task so Safari
		// still counts it as user-initiated.
		void previewHostBridge.approve(request);
	}

	function handlePermissionDeny(request: PendingPermission) {
		dequeuePermission(request);

		if (request.kind === 'file-pick') {
			pendingFilePick = null;
			// The page is blocked on an answer; an empty selection is how a
			// cancelled chooser is reported.
			void previewHostBridge.submitFiles(request, []);
			return;
		}

		previewHostBridge.deny(request);
	}

	function handleFilesPicked(event: Event) {
		const request = pendingFilePick;
		pendingFilePick = null;
		if (!request) return;

		const input = event.currentTarget as HTMLInputElement;
		void previewHostBridge.submitFiles(request, Array.from(input.files ?? []));
		input.value = '';
	}

	/**
	 * Seed the panel from the backend's buffer the first time it is opened.
	 *
	 * Live messages only start arriving once the panel mounts its listeners, so
	 * anything the page logged during load would otherwise be missing from the
	 * one view where it matters most.
	 */
	const seededConsoleTabs = new Set<string>();

	$effect(() => {
		if (!isConsoleOpen || !activeTabId || !sessionId) return;
		if (seededConsoleTabs.has(sessionId)) return;

		const tabId = activeTabId;
		const seedFor = sessionId;
		seededConsoleTabs.add(seedFor);

		void browserConsoleService
			.getConsoleLogs(seedFor)
			.then((logs) => {
				const tab = tabManager.getTab(tabId);
				if (!tab || logs.length === 0) return;

				// Merge rather than replace: live messages may already have landed
				// while this request was in flight.
				const known = new Set((tab.consoleLogs ?? []).map((entry) => entry.id));
				const missing = logs.filter((entry) => !known.has(entry.id));
				if (missing.length === 0) return;

				tabManager.updateTab(tabId, {
					consoleLogs: [...missing, ...(tab.consoleLogs ?? [])].sort((a, b) => a.timestamp - b.timestamp)
				});
			})
			.catch(() => {
				// Backend buffer unavailable — the live stream still fills the panel.
				seededConsoleTabs.delete(seedFor);
			});
	});

	async function clearConsole() {
		if (activeTabId) tabManager.updateTab(activeTabId, { consoleLogs: [] });
		try {
			await browserConsoleService.clearConsoleLogs(sessionId ?? '');
		} catch {
			// The local view is already cleared; a failed backend clear only means
			// its buffer keeps older entries, which no longer surface anywhere.
		}
	}

	async function executeConsoleCommand(commandText: string) {
		try {
			await browserConsoleService.executeConsoleCommand(sessionId ?? '', commandText);
		} catch (error) {
			debug.error('preview', 'Console command failed:', error);
		}
	}

	/**
	 * Browser-style shortcuts, scoped to the panel so they never shadow Clopen's
	 * own bindings while the user is working elsewhere.
	 */
	function handlePanelKeydown(event: KeyboardEvent) {
		const mod = event.metaKey || event.ctrlKey;

		if (mod && event.key.toLowerCase() === 'l') {
			event.preventDefault();
			toolbarRef?.focusAddressBar();
			return;
		}
		if (mod && event.key.toLowerCase() === 'r') {
			event.preventDefault();
			refreshPreview();
			return;
		}
		if (mod && event.key.toLowerCase() === 't') {
			event.preventDefault();
			coordinator.createNewTab();
			return;
		}
		if (mod && event.key.toLowerCase() === 'w') {
			if (!activeTabId) return;
			event.preventDefault();
			coordinator.closeTab(activeTabId);
			return;
		}
		if (event.altKey && event.key === 'ArrowLeft') {
			event.preventDefault();
			void navigateHistory('back');
			return;
		}
		if (event.altKey && event.key === 'ArrowRight') {
			event.preventDefault();
			void navigateHistory('forward');
			return;
		}
		// Chrome's own console shortcut, minus the DevTools it cannot open.
		if (mod && event.shiftKey && event.key.toLowerCase() === 'j') {
			event.preventDefault();
			isConsoleOpen = !isConsoleOpen;
		}
	}

	// ── Close all tabs ────────────────────────────────────────────────────────

	let showCloseAllConfirm = $state(false);

	/** Agent-driven tabs survive: closing one mid-run would fail the automation. */
	function closableTabIds(): string[] {
		const controlled = mcpHandler.getControlledTabIds();
		return tabs.filter((tab) => !controlled.has(tab.id)).map((tab) => tab.id);
	}

	const closeAllMessage = $derived.by(() => {
		const controlled = mcpHandler.getControlledTabIds();
		const closable = tabs.filter((tab) => !controlled.has(tab.id)).length;
		const locked = tabs.length - closable;

		if (locked > 0) {
			return `Close ${closable} tabs? ${locked} controlled by an agent will stay open.`;
		}
		return `Close all ${closable} tabs?`;
	});

	function requestCloseAllTabs() {
		if (closableTabIds().length === 0) return;
		showCloseAllConfirm = true;
	}

	function closeAllTabs() {
		showCloseAllConfirm = false;
		// Snapshot first: closing mutates the tab list this is derived from.
		for (const tabId of closableTabIds()) {
			coordinator.closeTab(tabId);
		}
	}

	function handleCanvasInteraction(action: any) {
		const tab = activeTab;
		if (tab && tab.sessionId) {
			// Hide the AI cursor instantly if the human explicitly interacts
			mcpVirtualCursor = { ...mcpVirtualCursor, visible: false };	
			coordinator.sendInteraction(action);
		}
	}

	function transformBrowserToDisplayCoordinates(browserX: number, browserY: number): { x: number, y: number } | null {
		// The canvas owns this conversion: it is the only place that knows both
		// where the frame is painted (the canvas is `object-contain`, so it is
		// letterboxed whenever the aspect ratios differ) and that the page's
		// coordinate space is the emulated viewport rather than the adaptive
		// capture bitmap. Re-deriving it here is how these overlays drifted away
		// from the element they were anchored to.
		try {
			return canvasAPI?.pageToScreen?.(browserX, browserY) ?? null;
		} catch (e) {
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

	// Hide MCP virtual cursor when switching to a non-MCP-controlled tab
	$effect(() => {
		void activeTabId; // track activeTabId changes
		if (!isCurrentTabMcpControlled()) {
			mcpVirtualCursor = { x: 0, y: 0, visible: false, clicking: false };
		}
	});

	// Stream message handling
	$effect(() => {
		if (activeTabId && sessionId) {
			// Message handling is done via coordinator
		}
	});

	// Expose methods for parent (PreviewPanel)
	export const browserActions = {
		getTouchMode: () => touchMode,
		setTouchMode: (mode: 'scroll' | 'cursor') => { touchMode = mode; },
		changeDeviceSize: (size: DeviceSize) => {
			coordinator.changeDeviceSize(size, previewDimensions?.scale);
		},
		toggleRotation: () => {
			coordinator.toggleRotation(previewDimensions?.scale);
		},
		getSessionInfo: () => sessionInfo,
		getIsStreamReady: () => isStreamReady,
		getErrorMessage: () => errorMessage,
		getIsMcpControlled: () => isCurrentTabMcpControlled()
	};
</script>

{#if isOpen && mode === 'split'}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		bind:this={panelElement}
		class="h-full flex flex-col theme-transition bg-slate-50 dark:bg-slate-900 dot-pattern"
		onkeydown={handlePanelKeydown}
		in:fly={{ x: 300, duration: 300, easing: cubicOut }}
		out:fly={{ x: 300, duration: 250, easing: cubicOut }}
	>
		<!-- Preview Toolbar -->
		<Toolbar
			bind:this={toolbarRef}
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
			{isConsoleOpen}
			{consoleIssueCount}
			{canGoBack}
			{canGoForward}
			{isMobile}
			showKeyboardToggle={!!canvasAPI?.supportsKeyboardToggle?.()}
			{tabs}
			{activeTabId}
			mcpControlledTabIds={mcpHandler.getControlledTabIds()}
			onGoClick={handleGoClick}
			onRefresh={refreshPreview}
			onStop={stopLoading}
			onBack={() => navigateHistory('back')}
			onForward={() => navigateHistory('forward')}
			onOpenInExternalBrowser={() => {}}
			onToggleConsole={() => (isConsoleOpen = !isConsoleOpen)}
			onToggleKeyboard={() => {
				if (canvasAPI?.isKeyboardActive?.()) canvasAPI.closeKeyboard();
				else canvasAPI?.openKeyboard?.();
			}}
			onUrlInput={() => {}}
			onAddressFocusChange={(focused: boolean) => (isEditingAddress = focused)}
			onUrlKeydown={() => {}}
			onSwitchTab={(tabId: string) => coordinator.switchToTab(tabId)}
			onCloseTab={(tabId: string) => coordinator.closeTab(tabId)}
			onReorderTab={(tabId: string, targetTabId: string) => tabManager.reorderTab(tabId, targetTabId)}
			onNewTab={() => coordinator.createNewTab()}
			onCloseAllTabs={requestCloseAllTabs}
		/>

		<!--
			Preview + console. The console docks below or beside, so the axis of
			this row flips with it rather than the console being repositioned.
		-->
		<div class="flex min-h-0 flex-1 {consoleDock === 'right' && isConsoleOpen ? 'flex-row' : 'flex-col'}">
		<div class="relative flex min-h-0 min-w-0 flex-1">
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
				bind:mcpVirtualCursor
				bind:canvasAPI
				bind:previewDimensions
				bind:lastFrameData={currentTabLastFrameData}
				bind:touchMode
				isMcpControlled={isCurrentTabMcpControlled()}
				onInteraction={handleCanvasInteraction}
				onRetry={handleGoClick}
			/>

			<!-- Page-owned prompts. Anchored to the preview area rather than the
			     app so they read as coming from the page, like a browser's own. -->
			<PermissionPrompt
				request={pendingPermission}
				onAllow={handlePermissionAllow}
				onDeny={handlePermissionDeny}
			/>

			<DialogOverlay
				dialog={currentDialog}
				origin={(() => {
					try {
						return new URL(url).origin;
					} catch {
						return '';
					}
				})()}
				onRespond={handleDialogResponse}
			/>
		</div>

		{#if isConsoleOpen}
			<ConsolePanel
				logs={consoleLogs}
				{isMobile}
				{panelWidth}
				bind:dock={consoleDock}
				bind:height={consoleHeight}
				bind:width={consoleWidth}
				onClose={() => (isConsoleOpen = false)}
				onClear={clearConsole}
				onExecute={executeConsoleCommand}
			/>
		{/if}
		</div>

		<!-- Native UI Overlays -->
		<SelectDropdown
			selectInfo={currentSelectInfo}
			scale={previewDimensions?.scale ?? 1}
			bounds={panelBounds}
			onSelect={handleSelectOption}
			onClose={closeSelectDropdown}
		/>

		<NativePicker
			picker={currentNativePicker}
			onCommit={(value: string) => {
				if (currentNativePicker) nativeUIHandler.respondNativePicker(currentNativePicker, value);
			}}
			onClose={() => (currentNativePicker = null)}
		/>

		<ContextMenu
			menuInfo={currentContextMenuInfo}
			scale={previewDimensions?.scale ?? 1}
			bounds={panelBounds}
			onSelectItem={handleContextMenuItem}
			onClose={closeContextMenu}
		/>

		<!-- Closing several tabs at once is worth a beat of confirmation. -->
		<Dialog
			bind:isOpen={showCloseAllConfirm}
			onClose={() => (showCloseAllConfirm = false)}
			type="warning"
			title="Close all tabs"
			message={closeAllMessage}
			confirmText="Close tabs"
			onConfirm={closeAllTabs}
		/>

		<!--
			File picker for intercepted `<input type="file">` in the page. Opened
			programmatically from the host bridge so the viewer chooses from their
			own filesystem — the headless browser has nothing worth picking.
		-->
		<input
			bind:this={filePickerElement}
			type="file"
			class="hidden"
			onchange={handleFilesPicked}
			oncancel={() => {
				const request = pendingFilePick;
				pendingFilePick = null;
				// The page is blocked on an answer; an empty selection is how a
				// cancelled chooser is reported.
				if (request) void previewHostBridge.submitFiles(request, []);
			}}
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
