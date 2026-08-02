import { EventEmitter } from 'events';
import type { Page } from 'puppeteer-core';
import { BrowserTabManager } from './browser-tab-manager.js';
import { BrowserConsoleManager } from './browser-console-manager.js';
import { BrowserInteractionHandler, type AutonomousRunOutcome } from './browser-interaction-handler.js';
import { BrowserNavigationTracker } from './browser-navigation-tracker.js';
import { BrowserVideoCapture } from './browser-video-capture.js';
import { BrowserDialogHandler } from './browser-dialog-handler.js';
import { BrowserNativeUIHandler } from './browser-native-ui-handler.js';
import { BrowserHostBridge, type HostResponse } from './browser-host-bridge.js';
import { browserMcpControl } from './browser-mcp-control.js';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import type {
	BrowserTab,
	BrowserTabInfo,
	BrowserConsoleMessage,
	BrowserAutonomousAction,
	DeviceSize,
	Rotation,
	BrowserDialogResponse,
	BrowserSelectResponse,
	BrowserContextMenuResponse,
	BrowserContextMenuInfo,
	BrowserHistoryState,
	BrowserTabMeta,
	ClientCodecSupport,
	ClientDisplayMetrics,
	ClientStreamFeedback
} from './types';

/**
 * Browser Preview Service
 *
 * Main orchestrator for browser preview functionality.
 * Tab-centric architecture - all operations work with tabs.
 *
 * Architecture:
 * - Tabs are the primary unit (no separate session concept)
 * - Each tab = isolated browser context + page
 * - Event-driven communication with frontend
 * - Manages all browser operations: streaming, interaction, console, etc.
 * - **PROJECT ISOLATION**: Each instance is isolated per project
 */
export class BrowserPreviewService extends EventEmitter {
	private tabManager: BrowserTabManager;
	private consoleManager: BrowserConsoleManager;
	private interactionHandler: BrowserInteractionHandler;
	private navigationTracker: BrowserNavigationTracker;
	private videoCapture: BrowserVideoCapture;
	private dialogHandler: BrowserDialogHandler;
	private nativeUIHandler: BrowserNativeUIHandler;
	private hostBridge: BrowserHostBridge;

	// Store context menu info for later action execution
	private contextMenus = new Map<string, BrowserContextMenuInfo>();

	// Project ID for isolation (REQUIRED)
	private projectId: string;

	constructor(projectId: string) {
		super();

		if (!projectId) {
			throw new Error('projectId is required for BrowserPreviewService');
		}

		this.projectId = projectId;

		// Initialize managers with projectId for isolation
		this.tabManager = new BrowserTabManager(projectId);
		this.consoleManager = new BrowserConsoleManager();
		this.interactionHandler = new BrowserInteractionHandler();
		this.navigationTracker = new BrowserNavigationTracker();
		this.videoCapture = new BrowserVideoCapture();
		this.dialogHandler = new BrowserDialogHandler();
		this.nativeUIHandler = new BrowserNativeUIHandler();
		this.hostBridge = new BrowserHostBridge();

		// Forward events from handlers to main service
		this.setupEventForwarding();
	}

	private setupEventForwarding() {
		// Forward console events
		this.consoleManager.on('console-message', (data) => {
			this.emit('preview:browser-console-message', data);
		});
		this.consoleManager.on('console-clear', (data) => {
			this.emit('preview:browser-console-clear', data);
		});

		// Cursor position/click are NOT forwarded here. They are published on the
		// browserMcpControl singleton, which setupMcpControlForwarding() relays
		// with the `source` stamp the client contract requires. Forwarding them
		// from here as well delivered every cursor update twice, once without
		// that field.
		this.interactionHandler.on('test-completed', (data) => {
			this.emit('preview:browser-mcp-test-completed', data);
		});

		// Forward navigation events and handle video streaming restart
		// Only full navigations (framenavigated) need streaming restart
		this.navigationTracker.on('navigation', async (data) => {
			this.emit('preview:browser-navigation', data);

			// After navigation completes, restart video streaming for the tab
			// This re-injects the peer script and restarts CDP screencast
			const { sessionId } = data;

			// Title/favicon/history changed with the document — push the new
			// values so the tab strip and Back/Forward buttons stay truthful.
			void this.refreshTabMeta(sessionId);
			if (this.videoCapture.isStreaming(sessionId)) {
				const tab = this.getTab(sessionId);
				if (tab) {
					// Restart streaming immediately — page is already navigated
					try {
						const success = await this.videoCapture.handleNavigation(sessionId, tab);
						if (success) {
							this.emit('preview:browser-navigation-streaming-ready', { sessionId });
						}
					} catch (error) {
						// Silently fail - frontend will request refresh if needed
					}
				}
			}
		});

		// Forward navigation loading events
		this.navigationTracker.on('navigation-loading', (data) => {
			this.emit('preview:browser-navigation-loading', data);
		});

		// Forward SPA navigation events (pushState/replaceState)
		// No streaming restart needed — page context is unchanged
		this.navigationTracker.on('navigation-spa', (data) => {
			this.emit('preview:browser-navigation-spa', data);
			// pushState/replaceState mutate history without a document swap, so
			// the Back/Forward affordances still have to be recomputed.
			void this.refreshTabMeta(data.sessionId);
		});

		// Forward new window events
		this.tabManager.on('new-window', (data) => {
			this.emit('preview:browser-new-window', data);
		});

		// Forward tab events (already have correct event names from tab manager)
		this.tabManager.on('preview:browser-tab-opened', (data) => {
			this.emit('preview:browser-tab-opened', data);
		});
		this.tabManager.on('preview:browser-tab-closed', (data) => {
			this.emit('preview:browser-tab-closed', data);
		});
		this.tabManager.on('preview:browser-tab-switched', (data) => {
			this.emit('preview:browser-tab-switched', data);
		});
		this.tabManager.on('preview:browser-tab-navigated', (data) => {
			this.emit('preview:browser-tab-navigated', data);
		});

		this.tabManager.on('preview:browser-viewport-changed', (data) => {
			this.emit('preview:browser-viewport-changed', data);
		});

		// Forward video capture events
		this.videoCapture.on('ice-candidate', (data) => {
			this.emit('preview:browser-webcodecs-ice-candidate', data);
		});
		this.videoCapture.on('connection-state', (data) => {
			this.emit('preview:browser-webcodecs-connection-state', data);
		});
		this.videoCapture.on('cursor-change', (data) => {
			this.emit('preview:browser-cursor-change', data);
		});
		this.videoCapture.on('navigation-streaming-ready', (data) => {
			this.emit('preview:browser-navigation-streaming-ready', data);
		});

		// Forward dialog events
		this.dialogHandler.on('dialog', (data) => {
			this.emit('preview:browser-dialog', data);
		});
		this.dialogHandler.on('dialog-closed', (data) => {
			this.emit('preview:browser-dialog-closed', data);
		});
		this.dialogHandler.on('print', (data) => {
			this.emit('preview:browser-print', data);
		});

		// Forward host bridge events (capability requests + relayed downloads)
		this.hostBridge.on('request', (data) => {
			this.emit('preview:browser-host-request', data);
		});
		this.hostBridge.on('download', (data) => {
			this.emit('preview:browser-download', data);
		});
		this.hostBridge.on('request-settled', (data) => {
			this.emit('preview:browser-host-request-settled', data);
		});

		// Forward native UI events
		this.nativeUIHandler.on('copy-to-clipboard', (data) => {
			this.emit('preview:browser-copy-to-clipboard', data);
		});
		this.nativeUIHandler.on('open-url-new-tab', (data) => {
			this.emit('preview:browser-open-url-new-tab', data);
		});
		this.nativeUIHandler.on('download-image', (data) => {
			this.emit('preview:browser-download-image', data);
		});
		this.nativeUIHandler.on('copy-image-to-clipboard', (data) => {
			this.emit('preview:browser-copy-image-to-clipboard', data);
		});
		this.nativeUIHandler.on('open-url-host-browser', (data) => {
			this.emit('preview:browser-open-url-host', data);
		});
		this.nativeUIHandler.on('print-page', (data) => {
			this.emit('preview:browser-print', { sessionId: this.getActiveTab()?.id ?? '', ...data });
		});
		this.nativeUIHandler.on('open-inspector', (data) => {
			this.emit('preview:browser-open-inspector', data);
		});
	}

	/**
	 * Get project ID for this service instance
	 */
	getProjectId(): string {
		return this.projectId;
	}

	// ============================================================================
	// Tab Management Methods
	// ============================================================================

	/**
	 * Create a new tab with optional URL
	 *
	 * If URL is provided, navigate to it immediately.
	 * If URL is not provided, create blank tab (about:blank).
	 *
	 * Default rotation depends on device size:
	 * - Desktop/laptop: landscape
	 * - Tablet/mobile: portrait
	 */
	async createTab(url?: string, deviceSize: DeviceSize = 'laptop', rotation?: Rotation): Promise<BrowserTab> {
		// Use device-appropriate default rotation if not specified
		const actualRotation = rotation || ((deviceSize === 'desktop' || deviceSize === 'laptop') ? 'landscape' : 'portrait');

		// Dialog interception and the capability shims both have to be in place
		// before the first navigation: a page can call alert() or getUserMedia()
		// from its very first inline script, and anything installed afterwards
		// would miss it.
		const preNavigationSetup = async (page: Page, tabId: string) => {
			await this.dialogHandler.setupDialogHandling(tabId, page);
			await this.hostBridge.setup(tabId, page);
		};

		// Create tab
		const tab = await this.tabManager.createTab(url, deviceSize, actualRotation, {
			setActive: true,
			preNavigationSetup
		});

		// Setup console, navigation tracking, and pre-inject streaming scripts in parallel
		await Promise.all([
			this.consoleManager.setupConsoleLogging(tab.id, tab.page, tab),
			this.navigationTracker.setupNavigationTracking(tab.id, tab.page, tab),
		]);

		// Pre-inject WebCodecs scripts so startStreaming() is fast (~50-80ms vs ~200-350ms)
		// Fire-and-forget: failure here is non-fatal, startStreaming() will retry injection
		this.videoCapture.preInjectScripts(tab.id, tab).catch(() => {});

		await this.captureHistoryBase(tab.id);
		void this.refreshTabMeta(tab.id);

		return tab;
	}

	/**
	 * Navigate tab to a new URL
	 */
	async navigateTab(tabId: string, url: string): Promise<string> {
		const wasBlank = this.getTab(tabId)?.url === 'about:blank';

		const actualUrl = await this.tabManager.navigateTab(tabId, url);

		// Mark navigation for frame deduplication
		this.markNavigation(tabId, url);

		// Chrome replaces a new tab's blank entry rather than stacking on top of
		// it, so Back stays disabled after the first real navigation. Re-baselining
		// here reproduces that instead of offering "back to about:blank".
		if (wasBlank) {
			await this.captureHistoryBase(tabId);
		}

		void this.refreshTabMeta(tabId);

		return actualUrl;
	}

	// ============================================================================
	// Navigation History (Back / Forward)
	// ============================================================================

	/**
	 * Read the tab's history, clamped to the entries it actually owns.
	 *
	 * CDP reports every entry including the `about:blank` the tab was born on.
	 * Offering that as a Back target would let the user reverse out of their page
	 * into a blank one — Chrome replaces that entry instead, so we hide anything
	 * before the index the tab settled on after its first navigation.
	 */
	async getHistoryState(tabId: string): Promise<BrowserHistoryState | null> {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		const history = await this.navigationTracker.getNavigationHistory(tabId, tab.page);
		if (!history) return null;

		const base = Math.min(tab.historyBaseIndex ?? 0, history.currentIndex);
		const entries = history.entries.slice(base);
		const currentIndex = history.currentIndex - base;

		return {
			entries,
			currentIndex,
			canGoBack: currentIndex > 0,
			canGoForward: currentIndex < entries.length - 1
		};
	}

	/**
	 * Move the tab by `delta` steps through its history.
	 * Returns false when the move would leave the tab's own range.
	 */
	async goHistory(tabId: string, delta: number): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab || delta === 0) return false;

		const state = await this.getHistoryState(tabId);
		if (!state) return false;

		const targetIndex = state.currentIndex + delta;
		const target = state.entries[targetIndex];
		if (!target) return false;

		const moved = await this.navigationTracker.navigateToHistoryEntry(tabId, tab.page, target.id);
		if (moved) {
			this.markNavigation(tabId, target.url);
			// The entry is committed asynchronously; let the navigation settle
			// before reading title/favicon back off the page.
			setTimeout(() => void this.refreshTabMeta(tabId), 250);
		}
		return moved;
	}

	/**
	 * Record where a freshly created tab's own history begins.
	 */
	private async captureHistoryBase(tabId: string): Promise<void> {
		const tab = this.getTab(tabId);
		if (!tab) return;

		const history = await this.navigationTracker.getNavigationHistory(tabId, tab.page);
		if (history) {
			tab.historyBaseIndex = history.currentIndex;
		}
	}

	/**
	 * Re-read the page's own title, favicon and history state, then push them to
	 * the frontend. Called after every navigation — these are the three things
	 * the toolbar and tab strip cannot derive from the URL alone.
	 */
	async refreshTabMeta(tabId: string): Promise<void> {
		const tab = this.getTab(tabId);
		if (!tab) return;

		try {
			const [pageTitle, favicon] = await Promise.all([
				tab.page.title().catch(() => ''),
				this.readFavicon(tab.page)
			]);

			if (pageTitle && pageTitle.trim()) {
				tab.title = pageTitle.trim();
			}
			if (favicon) {
				tab.favicon = favicon;
			}

			const history = await this.getHistoryState(tabId);
			tab.canGoBack = history?.canGoBack ?? false;
			tab.canGoForward = history?.canGoForward ?? false;

			const meta: BrowserTabMeta = {
				tabId,
				url: tab.url,
				title: tab.title,
				favicon: tab.favicon,
				canGoBack: tab.canGoBack,
				canGoForward: tab.canGoForward,
				timestamp: Date.now()
			};

			this.emit('preview:browser-tab-meta', meta);
		} catch (error) {
			debug.warn('preview', `⚠️ Failed to refresh tab meta for ${tabId}:`, error);
		}
	}

	/**
	 * Resolve the page's favicon to an absolute URL, falling back to the
	 * origin's /favicon.ico the way a browser does.
	 */
	private async readFavicon(page: Page): Promise<string | undefined> {
		try {
			return await page.evaluate(() => {
				const link = document.querySelector<HTMLLinkElement>(
					'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]'
				);
				if (link?.href) return link.href;
				if (location.origin && location.origin !== 'null') {
					return `${location.origin}/favicon.ico`;
				}
				return undefined;
			});
		} catch {
			return undefined;
		}
	}

	/**
	 * Close a tab and cleanup its resources
	 */
	async closeTab(tabId: string): Promise<{ success: boolean; newActiveTabId: string | null }> {
		const tab = this.tabManager.getTab(tabId);
		if (!tab) {
			return { success: false, newActiveTabId: null };
		}

		// Stop WebCodecs streaming first
		await this.stopWebCodecsStreaming(tabId);

		// Cleanup navigation tracker CDP session
		await this.navigationTracker.cleanupSession(tabId);

		// Clear cursor tracking for this tab
		this.interactionHandler.clearSessionCursor(tabId);

		// Clear dialogs for this tab
		this.dialogHandler.clearSessionDialogs(tabId);

		// Settle anything the page left waiting on the viewer, drop its scratch dir
		await this.hostBridge.teardown(tabId);

		// Close the tab (this will cleanup context, page, etc.)
		const result = await this.tabManager.closeTab(tabId);

		// Emit tab closed event (for MCP control manager and other listeners)
		this.emit('preview:browser-tab-destroyed', { tabId });

		return result;
	}

	/**
	 * Switch to a specific tab
	 */
	switchTab(tabId: string): boolean {
		return this.tabManager.setActiveTab(tabId);
	}

	/**
	 * Get a tab by ID
	 */
	getTab(tabId: string): BrowserTab | null {
		return this.tabManager.getTab(tabId);
	}

	/**
	 * Get the active tab
	 */
	getActiveTab(): BrowserTab | null {
		return this.tabManager.getActiveTab();
	}

	/**
	 * Get all tabs
	 */
	getAllTabs(): BrowserTab[] {
		return this.tabManager.getAllTabs();
	}

	/**
	 * Change viewport settings (device size and rotation) for an existing tab
	 */
	async setViewport(tabId: string, deviceSize: DeviceSize, rotation: Rotation): Promise<boolean> {
		return await this.tabManager.setViewport(tabId, deviceSize, rotation);
	}

	/**
	 * Get tab count
	 */
	getTabCount(): number {
		return this.tabManager.getTabCount();
	}

	/**
	 * Get tab info
	 */
	getTabInfo(tabId: string): BrowserTabInfo | null {
		return this.tabManager.getTabInfo(tabId);
	}

	/**
	 * Get all tabs info
	 */
	getAllTabsInfo(): BrowserTabInfo[] {
		return this.tabManager.getAllTabsInfo();
	}

	/**
	 * Get available tab IDs
	 */
	getAvailableTabIds(): string[] {
		return this.tabManager.getAvailableTabIds();
	}

	/**
	 * Get tabs status (for admin/debugging)
	 */
	getTabsStatus() {
		return this.tabManager.getTabsStatus();
	}

	/**
	 * Update tab title from URL
	 */
	updateTabTitleFromUrl(tabId: string, url: string): void {
		this.tabManager.updateTabTitleFromUrl(tabId, url);
	}

	/**
	 * Check if tab is valid
	 */
	isValidTab(tabId: string): boolean {
		const tab = this.getTab(tabId);
		return tab !== null && !tab.isDestroyed;
	}

	// ============================================================================
	// WebCodecs Streaming Methods (optimized, ~20-40ms, lower bandwidth)
	// ============================================================================
	async startWebCodecsStreaming(
		tabId: string,
		options: { viewerId: string; codecSupport?: ClientCodecSupport; display?: ClientDisplayMetrics }
	): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.startStreaming(
			tabId,
			tab,
			() => this.isValidTab(tabId),
			options
		);
	}

	/**
	 * Viewer display metrics (fit-scale + pixel density) — drives capture
	 * resolution so we never encode more pixels than the viewer can show.
	 */
	applyWebCodecsDisplayMetrics(tabId: string, viewerId: string, metrics: ClientDisplayMetrics): boolean {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		this.videoCapture.applyDisplayMetrics(tabId, tab, viewerId, metrics);
		return true;
	}

	/** Viewer decoder health — closes the adaptation loop back to the source. */
	applyWebCodecsClientFeedback(tabId: string, viewerId: string, feedback: ClientStreamFeedback): boolean {
		this.videoCapture.applyClientFeedback(tabId, viewerId, feedback);
		return true;
	}

	/** Suspend capture once every viewer has the preview off screen. */
	async setWebCodecsPaused(tabId: string, viewerId: string, paused: boolean): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.setViewerVisibility(tabId, tab, viewerId, !paused);
	}

	/**
	 * One viewer left. The capture only stops when the last one does — a second
	 * device closing its panel must not blank the first.
	 */
	async stopWebCodecsStreaming(tabId: string, viewerId?: string): Promise<void> {
		const tab = this.getTab(tabId);

		if (viewerId) {
			await this.videoCapture.detachViewer(tabId, tab ?? undefined, viewerId);
			return;
		}

		await this.videoCapture.stopStreaming(tabId, tab ?? undefined);
	}

	async refreshWebCodecsScreencast(tabId: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.refreshScreencast(tabId, tab);
	}

	async requestWebCodecsKeyframe(tabId: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.requestKeyframe(tabId, tab);
	}

	async updateWebCodecsViewport(tabId: string, width: number, height: number): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.updateViewport(tabId, tab, width, height);
	}

	async getWebCodecsOffer(tabId: string, viewerId: string): Promise<RTCSessionDescriptionInit | null> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return null;
		}
		return await this.videoCapture.createOffer(tabId, tab, viewerId);
	}

	async handleWebCodecsAnswer(
		tabId: string,
		viewerId: string,
		answer: RTCSessionDescriptionInit
	): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.handleAnswer(tabId, tab, viewerId, answer);
	}

	async addWebCodecsIceCandidate(
		tabId: string,
		viewerId: string,
		candidate: RTCIceCandidateInit
	): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) {
			return false;
		}
		return await this.videoCapture.addIceCandidate(tabId, tab, viewerId, candidate);
	}

	isWebCodecsActive(tabId: string): boolean {
		return this.videoCapture.isStreaming(tabId);
	}

	async getWebCodecsStats(tabId: string) {
		const tab = this.getTab(tabId);
		if (!tab) {
			return null;
		}
		return await this.videoCapture.getStats(tabId, tab);
	}

	markUserInteraction(tabId: string): void {
		this.tabManager.markTabActivity(tabId);
	}

	// Public method to mark tab activity (called from WS handlers)
	markActiveTabActivity(): void {
		const tab = this.getActiveTab();
		if (tab) {
			this.tabManager.markTabActivity(tab.id);
		}
	}

	markNavigation(tabId: string, _newUrl?: string): void {
		// Navigation tracking is now handled by WebCodecs automatically
		// This method is kept for API compatibility
	}

	// ============================================================================
	// Console Management Methods
	// ============================================================================
	getConsoleLogs(tabId: string): BrowserConsoleMessage[] {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.getConsoleLogs(tab) : [];
	}

	clearConsoleLogs(tabId: string): boolean {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.clearConsoleLogs(tab) : false;
	}

	toggleConsoleLogging(tabId: string, enabled: boolean): boolean {
		const tab = this.getTab(tabId);
		return tab ? this.consoleManager.toggleConsoleLogging(tab, enabled) : false;
	}

	async executeConsoleCommand(tabId: string, command: string): Promise<any> {
		const tab = this.getTab(tabId);
		if (!tab) throw new Error('Tab not found or invalid');
		return this.consoleManager.executeConsoleCommand(tab, command);
	}

	// ============================================================================
	// Interaction & Autonomous Actions Methods
	// ============================================================================
	/**
	 * Run a batch of input gestures.
	 *
	 * Returns per-action outcomes plus whether the run was cut short, so the
	 * caller can report "3 of 7 ran" instead of claiming a success the user
	 * interrupted.
	 */
	async performAutonomousActions(
		tabId: string,
		actions: BrowserAutonomousAction[],
		abortSignal?: AbortSignal
	): Promise<AutonomousRunOutcome> {
		const tab = this.getTab(tabId);
		if (!tab) throw new Error('Tab not found or invalid');

		return this.interactionHandler.performAutonomousActions(
			tabId,
			tab,
			actions,
			() => this.isValidTab(tabId) && !(abortSignal?.aborted ?? false)
		);
	}

	// ============================================================================
	// Dialog Management Methods
	// ============================================================================
	async respondToDialog(response: BrowserDialogResponse): Promise<boolean> {
		return await this.dialogHandler.respondToDialog(response);
	}

	// ============================================================================
	// Native UI Methods (Select & Context Menu)
	// ============================================================================
	async checkForSelectElement(tabId: string, x: number, y: number) {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		const selectInfo = await this.nativeUIHandler.checkForSelect(tabId, tab.page, x, y);
		if (selectInfo) {
			this.emit('preview:browser-select', selectInfo);
		}
		return selectInfo;
	}

	async handleSelectResponse(tabId: string, response: BrowserSelectResponse): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) return false;

		return await this.nativeUIHandler.handleSelectResponse(tab.page, response);
	}

	async checkForContextMenu(tabId: string, x: number, y: number) {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		// Back/Forward are page-level, so their availability comes from the tab's
		// history rather than from the element under the cursor.
		const history = await this.getHistoryState(tabId);
		const menuInfo = await this.nativeUIHandler.checkForContextMenu(tabId, tab.page, x, y, {
			canGoBack: history?.canGoBack ?? false,
			canGoForward: history?.canGoForward ?? false
		});
		if (menuInfo) {
			// Store menu info for later action execution
			this.contextMenus.set(menuInfo.menuId, menuInfo);
			this.emit('preview:browser-context-menu', menuInfo);
		}
		return menuInfo;
	}

	async handleContextMenuResponse(tabId: string, response: BrowserContextMenuResponse, clipboardText?: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) return false;

		// Get stored menu info
		const menuInfo = this.contextMenus.get(response.menuId);
		if (!menuInfo) return false;

		const result = await this.nativeUIHandler.handleContextMenuResponse(tab.page, response, menuInfo, clipboardText);

		// Clean up stored menu info
		this.contextMenus.delete(response.menuId);

		return result;
	}

	// ============================================================================
	// Host Bridge Methods
	// ============================================================================

	/**
	 * Deliver the viewer's answer to a pending capability request.
	 */
	respondToHostRequest(requestId: string, response: HostResponse): boolean {
		return this.hostBridge.respond(requestId, response);
	}

	/**
	 * Push a streamed host event into a tab's page — speech recognition results
	 * keep arriving long after the request that started them was answered.
	 */
	async dispatchHostEvent(tabId: string, kind: string, payload: unknown): Promise<void> {
		const tab = this.getTab(tabId);
		if (!tab) return;
		await this.hostBridge.dispatchEvent(tab.page, tabId, kind, payload);
	}

	// ============================================================================
	// Native Picker Methods (colour / date inputs)
	// ============================================================================

	/**
	 * Chrome draws colour and date pickers in the browser process, so they never
	 * reach the screencast. Detecting the input lets the viewer render the
	 * equivalent control over the canvas instead.
	 */
	async checkForNativePicker(tabId: string, x: number, y: number) {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		const info = await this.nativeUIHandler.checkForNativePicker(tabId, tab.page, x, y);
		if (info) {
			this.emit('preview:browser-native-picker', info);
		}
		return info;
	}

	async handleNativePickerResponse(tabId: string, pickerId: string, value: string): Promise<boolean> {
		const tab = this.getTab(tabId);
		if (!tab) return false;
		return await this.nativeUIHandler.handleNativePickerResponse(tab.page, pickerId, value);
	}

	// ============================================================================
	// Cleanup Methods
	// ============================================================================
	async cleanup() {
		// Clear all cursor tracking
		this.interactionHandler.clearAllSessionCursors();
		// Release host-bridge scratch dirs and unblock any parked page promises
		await this.hostBridge.cleanup();
		// Cleanup tabs (this will also cleanup all contexts/pages/browser pool)
		await this.tabManager.cleanup();
	}

	async cleanupInactiveTabs() {
		return this.tabManager.cleanupInactiveTabs();
	}

	async forceCleanupAll() {
		// First try normal cleanup
		await this.cleanup();

		// Cleanup video capture sessions
		await this.videoCapture.cleanup();

		// Clear all dialogs and context menus
		this.dialogHandler.clearAllDialogs();
		this.contextMenus.clear();

		// Remove all listeners to prevent memory leaks
		this.removeAllListeners();
		this.consoleManager.removeAllListeners();
		this.interactionHandler.removeAllListeners();
		this.navigationTracker.removeAllListeners();
		this.videoCapture.removeAllListeners();
		this.dialogHandler.removeAllListeners();
		this.nativeUIHandler.removeAllListeners();
		this.hostBridge.removeAllListeners();
	}
}

/**
 * Browser Preview Service Manager
 *
 * Manages BrowserPreviewService instances per project.
 * Provides project isolation - each project has its own browser tabs and state.
 */
class BrowserPreviewServiceManager {
	private services = new Map<string, BrowserPreviewService>();

	// Whether the singleton browserMcpControl listeners have been registered.
	// Guards against re-registering (and leaking) listeners on the shared emitter.
	private mcpForwardingSetup = false;

	/**
	 * Get or create a BrowserPreviewService for a project
	 */
	getService(projectId: string): BrowserPreviewService {
		// Typed as string, but this is reached from MCP tool handlers whose
		// arguments are untyped at runtime. A non-string key silently mints an
		// empty service (and leaks its WS forwarding listeners), so reject it
		// loudly rather than returning a service with no tabs.
		if (typeof projectId !== 'string' || !projectId) {
			throw new Error(`projectId must be a non-empty string, received: ${typeof projectId}`);
		}

		// Register singleton MCP control forwarding once (idempotent).
		this.setupMcpControlForwarding();

		if (!this.services.has(projectId)) {
			debug.log('preview', `🆕 Creating new BrowserPreviewService for project: ${projectId}`);
			const service = new BrowserPreviewService(projectId);
			this.services.set(projectId, service);

			// Setup WebSocket event forwarding for this service
			this.setupWebSocketForwarding(service, projectId);
			debug.log('preview', `✅ BrowserPreviewService fully initialized for project: ${projectId}`);
		}

		return this.services.get(projectId)!;
	}

	/**
	 * Setup WebSocket event forwarding for a service instance
	 * Events are emitted to the specific project only
	 */
	private setupWebSocketForwarding(service: BrowserPreviewService, projectId: string): void {
		debug.log('preview', `🔌 Setting up WebSocket forwarding for project: ${projectId}...`);

		// Forward WebCodecs events.
		//
		// The room is the whole project, so several viewers of the same tab all
		// receive these. `viewerId` is what lets each of them recognise the half
		// of the handshake that is theirs.
		service.on('preview:browser-webcodecs-ice-candidate', (data) => {
			ws.emit.project(projectId, 'preview:browser-stream-ice', {
				sessionId: data.sessionId,
				viewerId: data.viewerId,
				candidate: data.candidate,
				from: data.from
			});
		});

		service.on('preview:browser-webcodecs-connection-state', (data) => {
			ws.emit.project(projectId, 'preview:browser-stream-state', data);
		});

		service.on('preview:browser-cursor-change', (data) => {
			ws.emit.project(projectId, 'preview:browser-cursor-change', data);
		});

		// Forward navigation events
		service.on('preview:browser-navigation-loading', (data) => {
			ws.emit.project(projectId, 'preview:browser-navigation-loading', data);
		});

		service.on('preview:browser-navigation', (data) => {
			ws.emit.project(projectId, 'preview:browser-navigation', data);
		});

		// Forward SPA navigation events (pushState/replaceState — URL-only update)
		service.on('preview:browser-navigation-spa', (data) => {
			ws.emit.project(projectId, 'preview:browser-navigation-spa', data);
		});

		// Forward tab events. Each carries projectId so the frontend can drop
		// events for a project it has since switched away from — without it, a
		// background stream (or a late event) could create/mutate tabs in the
		// project the user is now viewing.
		service.on('preview:browser-tab-opened', (data) => {
			debug.log('preview', `🚀 Forwarding preview:browser-tab-opened to project ${projectId}:`, data);
			ws.emit.project(projectId, 'preview:browser-tab-opened', { ...data, projectId });
		});

		service.on('preview:browser-tab-closed', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-closed', { ...data, projectId });
		});

		service.on('preview:browser-tab-switched', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-switched', { ...data, projectId });
		});

		service.on('preview:browser-tab-navigated', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-navigated', { ...data, projectId });
		});

		service.on('preview:browser-viewport-changed', (data) => {
			ws.emit.project(projectId, 'preview:browser-viewport-changed', { ...data, projectId });
		});

		// Forward live tab metadata (title, favicon, back/forward availability)
		service.on('preview:browser-tab-meta', (data) => {
			ws.emit.project(projectId, 'preview:browser-tab-meta', { ...data, projectId });
		});

		// Forward host-capability requests (geolocation, camera, clipboard, …)
		// and relayed downloads — both are answered by the viewer's own browser.
		service.on('preview:browser-host-request', (data) => {
			ws.emit.project(projectId, 'preview:browser-host-request', data);
		});

		// Answered (or expired) — every viewer that was shown this prompt drops it.
		service.on('preview:browser-host-request-settled', (data) => {
			ws.emit.project(projectId, 'preview:browser-host-request-settled', data);
		});

		service.on('preview:browser-download', (data) => {
			ws.emit.project(projectId, 'preview:browser-download', data);
		});

		// Forward console events
		service.on('preview:browser-console-message', (data) => {
			ws.emit.project(projectId, 'preview:browser-console-message', data);
		});

		service.on('preview:browser-console-clear', (data) => {
			ws.emit.project(projectId, 'preview:browser-console-clear', data);
		});

		// Forward MCP events. Cursor position/click come from the singleton
		// instead (setupMcpControlForwarding) — see setupEventForwarding().
		service.on('preview:browser-mcp-test-completed', (data) => {
			ws.emit.project(projectId, 'preview:browser-mcp-test-completed', data);
		});

		// Forward dialog events
		service.on('preview:browser-dialog', (data) => {
			ws.emit.project(projectId, 'preview:browser-dialog', data);
		});

		// A dialog belongs to the page, not to whoever answered it: every viewer
		// was shown the same prompt, so all of them are told it is settled.
		service.on('preview:browser-dialog-closed', (data) => {
			ws.emit.project(projectId, 'preview:browser-dialog-closed', data);
		});

		service.on('preview:browser-print', (data) => {
			ws.emit.project(projectId, 'preview:browser-print', data);
		});

		// Forward native UI events
		service.on('preview:browser-native-picker', (data) => {
			ws.emit.project(projectId, 'preview:browser-native-picker', data);
		});

		service.on('preview:browser-select', (data) => {
			ws.emit.project(projectId, 'preview:browser-select', data);
		});

		service.on('preview:browser-context-menu', (data) => {
			ws.emit.project(projectId, 'preview:browser-context-menu', data);
		});

		service.on('preview:browser-copy-to-clipboard', (data) => {
			ws.emit.project(projectId, 'preview:browser-copy-to-clipboard', data);
		});

		service.on('preview:browser-open-url-new-tab', (data) => {
			ws.emit.project(projectId, 'preview:browser-open-url-new-tab', data);
		});

		service.on('preview:browser-download-image', (data) => {
			ws.emit.project(projectId, 'preview:browser-download-image', data);
		});

		service.on('preview:browser-open-url-host', (data) => {
			ws.emit.project(projectId, 'preview:browser-open-url-host', data);
		});

		service.on('preview:browser-open-inspector', (data) => {
			ws.emit.project(projectId, 'preview:browser-open-inspector', data);
		});

		service.on('preview:browser-copy-image-to-clipboard', (data) => {
			ws.emit.project(projectId, 'preview:browser-copy-image-to-clipboard', data);
		});

		// Forward new window events
		service.on('preview:browser-new-window', (data) => {
			ws.emit.project(projectId, 'preview:browser-new-window', data);
		});

		// MCP control events come from the singleton browserMcpControl, so their
		// listeners are registered once globally (see setupMcpControlForwarding) —
		// NOT here, which runs per-project and would leak listeners onto the
		// singleton as projects are opened.

		debug.log('preview', `🎉 All WebSocket event listeners registered for project: ${projectId}`);
	}

	/**
	 * Setup WebSocket forwarding for the singleton browserMcpControl.
	 *
	 * Registered exactly once for the whole manager. The emitter is a singleton
	 * shared across all projects, so attaching these listeners per-project would
	 * accumulate them without bound (MaxListenersExceededWarning). MCP control
	 * events are not project-scoped at the source, so we broadcast them to every
	 * currently-active project; the frontend filters by tab/session.
	 */
	private setupMcpControlForwarding(): void {
		if (this.mcpForwardingSetup) return;
		this.mcpForwardingSetup = true;

		const emitToActiveProjects = <K extends Parameters<typeof ws.emit.project>[1]>(
			event: K,
			payload: Parameters<typeof ws.emit.project<K>>[2]
		) => {
			for (const projectId of this.services.keys()) {
				ws.emit.project(projectId, event, payload);
			}
		};

		// Control events are project-scoped: emit ONLY to the owning project's room
		// and stamp projectId. Tab IDs (tab-N) repeat across projects, so a broadcast
		// would let project A's control event mismark a same-numbered tab in project B.
		browserMcpControl.on('control-start', (data) => {
			debug.log('preview', '🚀 Forwarding mcp-control-start:', data);
			if (!data.projectId) return;
			ws.emit.project(data.projectId, 'preview:browser-mcp-control-start', {
				browserTabId: data.browserTabId,
				chatSessionId: data.chatSessionId,
				projectId: data.projectId,
				timestamp: data.timestamp
			});
		});

		browserMcpControl.on('control-end', (data) => {
			debug.log('preview', '🚀 Forwarding mcp-control-end:', data);
			if (!data.projectId) return;
			ws.emit.project(data.projectId, 'preview:browser-mcp-control-end', {
				browserTabId: data.browserTabId,
				projectId: data.projectId,
				timestamp: data.timestamp
			});
		});

		browserMcpControl.on('cursor-position', (data) => {
			emitToActiveProjects('preview:browser-mcp-cursor-position', {
				sessionId: data.tabId,
				x: data.x,
				y: data.y,
				pressed: data.pressed ?? false,
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});

		browserMcpControl.on('cursor-click', (data) => {
			emitToActiveProjects('preview:browser-mcp-cursor-click', {
				sessionId: data.tabId,
				x: data.x,
				y: data.y,
				button: data.button ?? 'left',
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});

		browserMcpControl.on('test-completed', (data) => {
			emitToActiveProjects('preview:browser-mcp-test-completed', {
				sessionId: data.tabId,
				timestamp: data.timestamp,
				source: 'mcp'
			});
		});
	}

	/**
	 * Check if a service exists for a project
	 */
	hasService(projectId: string): boolean {
		if (!projectId) {
			throw new Error('projectId is required and cannot be empty');
		}
		return this.services.has(projectId);
	}

	/**
	 * Remove a service for a project (cleanup)
	 */
	async removeService(projectId: string): Promise<void> {
		if (!projectId) {
			throw new Error('projectId is required and cannot be empty');
		}

		const service = this.services.get(projectId);

		if (service) {
			await service.forceCleanupAll();
			this.services.delete(projectId);
		}
	}

	/**
	 * Cleanup all services
	 */
	async cleanup(): Promise<void> {
		const cleanupPromises = Array.from(this.services.values()).map(service =>
			service.forceCleanupAll().catch(error => {
				console.error('Error cleaning up service:', error);
			})
		);

		await Promise.all(cleanupPromises);
		this.services.clear();
	}

	/**
	 * Get all active project IDs
	 */
	getActiveProjects(): string[] {
		return Array.from(this.services.keys());
	}

	/**
	 * Get stats for all services
	 */
	getStats() {
		const stats = new Map<string, any>();

		for (const [projectId, service] of this.services.entries()) {
			stats.set(projectId, {
				projectId,
				tabs: service.getTabsStatus()
			});
		}

		return stats;
	}
}

// Service manager instance (singleton)
export const browserPreviewServiceManager = new BrowserPreviewServiceManager();

