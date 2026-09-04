import type { Browser, BrowserContext, Page, Target } from 'puppeteer';
import { EventEmitter } from 'events';
import { getViewportDimensions } from '$shared/constants/preview.js';
import type { BrowserTab, BrowserTabInfo, DeviceSize, Rotation } from './types';
import { DEFAULT_STREAMING_CONFIG } from './types';
import { browserPool, type PooledSession } from './browser-pool';
import { BrowserAudioCapture } from './browser-audio-capture';
import { cursorTrackingScript } from './scripts/cursor-tracking';
import { browserMcpControl } from './browser-mcp-control';
import { debug } from '$shared/utils/logger';
import { scopeSlug } from '$shared/utils/workspace-scope';

// Tab cleanup configuration
const INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 60 * 1000; // Check every minute

/**
 * Shortest gap between two rebuild requests for the same tab.
 *
 * The health check runs from read paths that fire many times a second (the
 * stream's per-frame guard, the tab list, an MCP action's pre-check), so
 * without this a single dead page would ask for a rebuild on every one of
 * them. Long enough that a failed rebuild backs off, short enough that the
 * page is back before anyone reaches for reload.
 */
const RECOVERY_REQUEST_INTERVAL = 5 * 1000;

/**
 * Why a tab's underlying page cannot be driven right now.
 *
 * All three are recoverable: the tab keeps its identity and the page is
 * rebuilt underneath it. None of them is a reason to delete the tab.
 */
export type TabAilment = 'browser-gone' | 'session-gone' | 'page-gone';

/**
 * Browser Tab Manager
 *
 * Tab-centric architecture where each tab represents a complete browser instance.
 * Manages tab lifecycle, creation, navigation, and cleanup.
 *
 * ARCHITECTURE:
 * - Tabs are the primary unit (no separate "session" concept)
 * - Each tab has its own isolated browser context + page from the pool
 * - 1 shared browser + isolated contexts = ~20 MB per tab
 * - Active tab tracking for operations
 * - Event-driven for frontend sync
 * - **PROJECT ISOLATION**: Sessions are prefixed with projectId
 *
 * ISOLATION GUARANTEE:
 * Each tab gets its own BrowserContext which provides:
 * - Separate cookies
 * - Separate localStorage/sessionStorage
 * - Separate cache
 * - Separate service workers
 * - No data leakage between tabs
 * - No data leakage between projects (via projectId-prefixed sessionIds)
 */
export class BrowserTabManager extends EventEmitter {
	private tabs = new Map<string, BrowserTab>();
	private activeTabId: string | null = null;
	private nextTabNumber = 1;

	// Tab activity tracking for cleanup
	private tabActivity = new Map<string, number>();
	private cleanupInterval: NodeJS.Timeout | null = null;
	private signalHandlers: { sigterm: () => void; sigint: () => void } | null = null;

	/** Tabs whose close is already running, so closeTab is idempotent. */
	private closingTabs = new Set<string>();

	/**
	 * Set once the process is on its way out, and while a workspace teardown is
	 * running. Both close every page on purpose, and without this each one would
	 * read as a crash worth relaunching Chrome for.
	 */
	private shuttingDown = false;

	/** When a rebuild was last asked for, per tab — see RECOVERY_REQUEST_INTERVAL. */
	private recoveryRequestedAt = new Map<string, number>();

	/**
	 * Per-tab page setup that has to run again on every page the tab gets.
	 * Dialog interception and the host-capability shims must be installed
	 * before the first navigation, so a rebuilt page needs them re-applied
	 * exactly as the original one did.
	 */
	private tabSetupHooks = new Map<string, (page: Page, tabId: string) => Promise<void>>();

	/**
	 * The listeners a tab holds on objects that outlive its page — the shared
	 * browser and its own context. A rebuild has to take these off before it
	 * fits new ones: left attached, the old popup watcher would see the tab's
	 * replacement page as a popup and close it on sight.
	 */
	private tabListeners = new Map<
		string,
		{
			browser: Browser;
			onDisconnected: () => void;
			context: BrowserContext;
			onTargetCreated: (target: Target) => void;
		}
	>();

	// Audio capture manager
	private audioCapture = new BrowserAudioCapture();

	// Project ID for session isolation (REQUIRED)
	private projectId: string;

	constructor(projectId: string) {
		super();

		if (!projectId) {
			throw new Error('projectId is required for BrowserTabManager');
		}

		this.projectId = projectId;
		// Initialize periodic cleanup
		this.initializeCleanup();
	}

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
	async createTab(
		url?: string,
		deviceSize: DeviceSize = 'laptop',
		rotation: Rotation = 'landscape',
		options?: {
			setActive?: boolean;
			preNavigationSetup?: (page: Page, tabId: string) => Promise<void>;
		}
	): Promise<BrowserTab> {
		// The counter restarts per workspace, so the scope token is what stops a
		// worktree's `tab-1` from being matched as the main tree's on the client.
		const tabId = `tab-${scopeSlug(this.projectId)}-${this.nextTabNumber++}`;
		const finalUrl = url || 'about:blank';

		debug.log('preview', `🟡🟡🟡 Creating new tab: ${tabId} for project: ${this.projectId} 🟡🟡🟡`);
		debug.log('preview', `📁 Tab URL: ${finalUrl}, deviceSize: ${deviceSize}, rotation: ${rotation}`);

		let browser: Browser;
		let context: BrowserContext;
		let page: Page;

		try {
			// Create project-scoped sessionId for isolation
			// Format: "projectId:tabId" ensures complete isolation between projects
			const sessionId = `${this.projectId}:${tabId}`;

			// Create isolated context via puppeteer-cluster
			// This provides full isolation: cookies, localStorage, sessionStorage, cache
			const pooledSession = await browserPool.createSession(sessionId);
			browser = await browserPool.getBrowser();
			context = pooledSession.context;
			page = pooledSession.page;

			debug.log('preview', `🔐 Session ID: ${sessionId} (project-scoped)`);
		} catch (poolError) {
			debug.error('preview', `❌ Browser pool error:`, poolError);
			throw poolError;
		}

		debug.log('preview', `✅ Isolated context created for tab: ${tabId}`);

		// Setup page (viewport, headers, etc.)
		debug.log('preview', `⚙️ Setting up page...`);
		await this.setupPage(page, deviceSize, rotation);
		debug.log('preview', `✅ Page setup complete`);

		// Run pre-navigation setup if provided (e.g., dialog handling)
		if (options?.preNavigationSetup) {
			debug.log('preview', `🔧 Running pre-navigation setup...`);
			await options.preNavigationSetup(page, tabId);
			debug.log('preview', `✅ Pre-navigation setup complete`);
		}

		// Navigate to URL (or about:blank)
		debug.log('preview', `🌐 Navigating to: ${finalUrl}`);
		const actualUrl = await this.navigateWithRetry(page, finalUrl);
		debug.log('preview', `✅ Navigation complete - final URL: ${actualUrl}`);

		// Get title from URL
		const title = this.getTitleFromUrl(actualUrl);

		// Create tab object
		const tab: BrowserTab = {
			// Identity
			id: tabId,
			url: actualUrl,
			title,
			isActive: false,

			// Browser instances
			browser,
			context,
			page,

			// Streaming
			isStreaming: false,
			quality: 'good',

			// Device
			deviceSize,
			rotation,

			// Console
			consoleLogs: [],
			consoleEnabled: true,

			// Navigation
			isLoading: false,
			canGoBack: false,
			canGoForward: false,
			currentUrl: actualUrl,

			// Timestamps
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),

			// Internal
			isDestroyed: false,
			lastFrameHash: undefined,
			duplicateFrameCount: 0,
			lastInteractionTime: undefined,
			lastNavigationTime: undefined
		};

		this.tabs.set(tabId, tab);
		// Kept for the life of the tab: a rebuilt page needs the same setup the
		// original one got, before it navigates anywhere.
		if (options?.preNavigationSetup) {
			this.tabSetupHooks.set(tabId, options.preNavigationSetup);
		}
		this.setupBrowserHandlers(tabId, browser, context, page);

		// Mark tab as active immediately
		this.markTabActivity(tabId);

		// Set as active if requested or if it's the first tab
		if (options?.setActive !== false) {
			this.setActiveTab(tabId);
		}

		// Emit tab created event with device info
		const tabOpenedEvent = {
			tabId,
			url: actualUrl,
			title,
			isActive: tab.isActive,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			timestamp: Date.now()
		};

		debug.log('preview', `📤 Emitting preview:browser-tab-opened event:`, tabOpenedEvent);
		this.emit('preview:browser-tab-opened', tabOpenedEvent);

		debug.log('preview', `✅ Tab created: ${tabId} (active: ${tab.isActive})`);

		// Log pool stats
		const stats = browserPool.getStats();
		debug.log('preview', `📊 Pool stats: ${stats.activeSessions}/${stats.maxConcurrency} tabs active`);

		return tab;
	}

	/**
	 * Navigate tab to a new URL
	 */
	async navigateTab(tabId: string, url: string): Promise<string> {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			throw new Error(`Tab not found: ${tabId}`);
		}

		debug.log('preview', `🌐 Navigating tab ${tabId} to: ${url}`);

		// Mark as loading
		tab.isLoading = true;

		try {
			// Navigate (streaming continues, handlers reused)
			const actualUrl = await this.navigateWithRetry(tab.page, url);

			// Update tab properties
			tab.url = actualUrl;
			tab.currentUrl = actualUrl;
			tab.title = this.getTitleFromUrl(actualUrl);
			tab.lastNavigationTime = Date.now();
			tab.isLoading = false;

			// Update navigation state
			tab.canGoBack = (await tab.page.evaluate(() => window.history.length)) > 1;
			tab.canGoForward = false;

			// Mark activity
			this.markTabActivity(tabId);

			// Emit navigation event
			this.emit('preview:browser-tab-navigated', {
				tabId,
				url: actualUrl,
				title: tab.title,
				timestamp: Date.now()
			});

			debug.log('preview', `✅ Tab ${tabId} navigated to: ${actualUrl}`);

			return actualUrl;
		} catch (error) {
			tab.isLoading = false;
			throw error;
		}
	}

	/**
	 * Close a tab and cleanup its resources
	 */
	async closeTab(tabId: string): Promise<{ success: boolean; newActiveTabId: string | null }> {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			debug.warn('preview', `❌ Tab not found: ${tabId}`);
			return { success: false, newActiveTabId: null };
		}

		// Closing is reachable from several places at once (the user, an MCP
		// batch, the idle sweep). Running it twice destroys the pool session
		// under the half that is still working.
		if (this.closingTabs.has(tabId)) {
			debug.log('preview', `⏭️ Tab ${tabId} is already closing`);
			return { success: false, newActiveTabId: null };
		}
		this.closingTabs.add(tabId);

		try {
			debug.log('preview', `🗑️ Closing tab: ${tabId}`);

			const wasActive = tab.isActive;

			// Auto-release MCP control if this tab is being controlled
			browserMcpControl.autoReleaseForTab(tabId, this.projectId);

			// IMMEDIATELY set destroyed flag and stop streaming
			tab.isDestroyed = true;
			tab.isStreaming = false;

			// Clear all intervals immediately
			if (tab.screenshotInterval) {
				clearInterval(tab.screenshotInterval);
				tab.screenshotInterval = undefined;
			}
			if (tab.streamingInterval) {
				clearInterval(tab.streamingInterval);
				tab.streamingInterval = undefined;
			}

			// Wait a moment for streaming loop to detect the flags and stop
			await new Promise(resolve => setTimeout(resolve, 500));

			// Clean up the isolated context
			await this.cleanupContext(tab);

			// Remove from map
			this.detachTabListeners(tabId);
			this.tabs.delete(tabId);
			this.tabActivity.delete(tabId);
			this.tabSetupHooks.delete(tabId);
			this.recoveryRequestedAt.delete(tabId);

			// If closing active tab, switch to another tab
			let newActiveTabId: string | null = null;
			if (wasActive && this.tabs.size > 0) {
				// Get the first available tab
				const nextTab = Array.from(this.tabs.values())[0];
				if (nextTab) {
					this.setActiveTab(nextTab.id);
					newActiveTabId = nextTab.id;
				} else {
					this.activeTabId = null;
				}
			} else if (this.tabs.size === 0) {
				this.activeTabId = null;
			}

			// Emit tab closed event
			this.emit('preview:browser-tab-closed', {
				tabId,
				newActiveTabId,
				timestamp: Date.now()
			});

			debug.log('preview', `✅ Tab closed: ${tabId} (new active: ${newActiveTabId || 'none'})`);

			// Log pool stats after cleanup
			const stats = browserPool.getStats();
			debug.log('preview', `📊 Pool stats after cleanup: ${stats.activeSessions}/${stats.maxConcurrency} tabs active`);

			return { success: true, newActiveTabId };
		} finally {
			this.closingTabs.delete(tabId);
		}
	}

	/**
	 * Switch to a specific tab
	 */
	setActiveTab(tabId: string): boolean {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			debug.warn('preview', `❌ Cannot switch to tab: ${tabId} (not found)`);
			return false;
		}

		const previousTabId = this.activeTabId;

		// Deactivate previous active tab
		if (previousTabId && previousTabId !== tabId) {
			const previousTab = this.tabs.get(previousTabId);
			if (previousTab) {
				previousTab.isActive = false;
			}
		}

		// Activate new tab
		tab.isActive = true;
		tab.lastAccessedAt = Date.now();
		this.activeTabId = tabId;

		// Mark tab activity
		this.markTabActivity(tabId);

		// Emit tab switched event
		if (previousTabId !== tabId) {
			this.emit('preview:browser-tab-switched', {
				previousTabId: previousTabId || '',
				newTabId: tabId,
				timestamp: Date.now()
			});

			debug.log('preview', `🔄 Switched tab: ${previousTabId || 'none'} → ${tabId}`);
		}

		return true;
	}

	/**
	 * Get a tab by ID
	 */
	getTab(tabId: string): BrowserTab | null {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return null;
		}

		// Validate tab before returning
		if (!this.isValidTab(tabId)) {
			return null;
		}

		return tab;
	}

	/**
	 * Get a tab without validating its page.
	 *
	 * The counterpart to `getTab`: used by the rebuild path, which needs the
	 * record of a tab precisely when its page is the thing that is broken.
	 */
	peekTab(tabId: string): BrowserTab | null {
		return this.tabs.get(tabId) ?? null;
	}

	/**
	 * Get the active tab
	 */
	getActiveTab(): BrowserTab | null {
		if (!this.activeTabId) return null;
		return this.getTab(this.activeTabId);
	}

	/**
	 * Change viewport settings (device size and rotation) for an existing tab
	 */
	async setViewport(tabId: string, deviceSize: DeviceSize, rotation: Rotation): Promise<boolean> {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			debug.warn('preview', `❌ Cannot set viewport: Tab ${tabId} not found`);
			return false;
		}

		// Get new viewport dimensions
		const { width: viewportWidth, height: viewportHeight } = getViewportDimensions(deviceSize, rotation);

		try {
			// Update viewport on the page
			await tab.page.setViewport({ width: viewportWidth, height: viewportHeight });

			// Update tab metadata
			tab.deviceSize = deviceSize;
			tab.rotation = rotation;

			// Mark tab activity
			this.markTabActivity(tabId);

			// Emit viewport changed event
			this.emit('preview:browser-viewport-changed', {
				tabId,
				deviceSize,
				rotation,
				width: viewportWidth,
				height: viewportHeight,
				timestamp: Date.now()
			});

			debug.log('preview', `📱 Viewport changed for tab ${tabId}: ${deviceSize} (${rotation}) - ${viewportWidth}x${viewportHeight}`);

			return true;
		} catch (error) {
			debug.error('preview', `❌ Failed to set viewport for tab ${tabId}:`, error);
			return false;
		}
	}

	/**
	 * Get all tabs
	 */
	getAllTabs(): BrowserTab[] {
		return Array.from(this.tabs.values());
	}

	/**
	 * Get tab count
	 */
	getTabCount(): number {
		return this.tabs.size;
	}

	/**
	 * Check if a tab exists
	 */
	hasTab(tabId: string): boolean {
		return this.tabs.has(tabId);
	}

	/**
	 * Get active tab ID
	 */
	getActiveTabId(): string | null {
		return this.activeTabId;
	}

	/**
	 * Get tab info
	 */
	getTabInfo(tabId: string): BrowserTabInfo | null {
		const tab = this.getTab(tabId);
		if (!tab) return null;

		return {
			id: tab.id,
			url: tab.url,
			title: tab.title,
			favicon: tab.favicon,
			quality: tab.quality,
			isStreaming: tab.isStreaming,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			isActive: tab.isActive,
			canGoBack: tab.canGoBack,
			canGoForward: tab.canGoForward
		};
	}

	/**
	 * Get all tabs info
	 */
	getAllTabsInfo(): BrowserTabInfo[] {
		return Array.from(this.tabs.values()).map(tab => ({
			id: tab.id,
			url: tab.url,
			title: tab.title,
			favicon: tab.favicon,
			quality: tab.quality,
			isStreaming: tab.isStreaming,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			isActive: tab.isActive,
			canGoBack: tab.canGoBack,
			canGoForward: tab.canGoForward
		}));
	}

	/**
	 * Get tabs status (for admin/debugging)
	 */
	getTabsStatus() {
		const tabs = Array.from(this.tabs.entries()).map(([id, tab]) => ({
			id,
			url: tab.url,
			title: tab.title,
			isStreaming: tab.isStreaming,
			isDestroyed: tab.isDestroyed || false,
			browserConnected: tab.browser?.connected || false,
			// `tab.page?.isClosed() || true` — the shape this used to have — is
			// always true, which reported every tab as a dead one.
			pageClosed: tab.page ? tab.page.isClosed() : true,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			consoleLogs: tab.consoleLogs.length,
			lastInteractionTime: tab.lastInteractionTime,
			duplicateFrameCount: tab.duplicateFrameCount || 0,
			isActive: tab.isActive,
			isRecovering: tab.isRecovering || false,
			createdAt: tab.createdAt,
			lastAccessedAt: tab.lastAccessedAt
		}));

		// "Alive" is about the page, not about whether anyone is watching it:
		// a tab whose panel is closed is not streaming and is perfectly fine.
		// The inactive-mode cleanup uses the same definition, so what this
		// reports is what that mode would actually remove.
		const isDead = (t: (typeof tabs)[number]) =>
			t.isDestroyed || (!t.isRecovering && (!t.browserConnected || t.pageClosed));

		return {
			totalTabs: tabs.length,
			activeTabs: tabs.filter(t => !isDead(t)).length,
			inactiveTabs: tabs.filter(isDead).length,
			tabs
		};
	}

	/**
	 * Update tab title
	 */
	updateTabTitle(tabId: string, title: string): void {
		const tab = this.tabs.get(tabId);
		if (tab) {
			tab.title = title;
		}
	}

	/**
	 * Update tab title from URL
	 */
	updateTabTitleFromUrl(tabId: string, url: string): void {
		const tab = this.tabs.get(tabId);
		if (tab) {
			tab.title = this.getTitleFromUrl(url);
		}
	}

	/**
	 * Get project-scoped session ID for a tab
	 */
	private getSessionId(tabId: string): string {
		return this.projectId ? `${this.projectId}:${tabId}` : tabId;
	}

	/**
	 * What, if anything, is wrong with a tab's page. Pure — it only looks.
	 *
	 * Deliberately side-effect free: this is called from read paths (the tab
	 * list, the stream's per-frame guard, an MCP action's pre-check), and it
	 * used to close the tab from all of them. A page that dies for a moment is
	 * not a request to throw the tab away, and answering one that way is what
	 * made previews disappear with nobody having closed anything.
	 */
	diagnoseTab(tabId: string): TabAilment | null {
		const tab = this.tabs.get(tabId);
		if (!tab) return null;

		if (!tab.browser || !tab.browser.connected) return 'browser-gone';
		if (!browserPool.isSessionValid(this.getSessionId(tabId))) return 'session-gone';
		if (!tab.page || tab.page.isClosed()) return 'page-gone';

		return null;
	}

	/**
	 * Ask for a tab's page to be rebuilt.
	 *
	 * The tab manager cannot do it alone — console logging, navigation
	 * tracking and the streaming scripts are all owned a layer up — so this
	 * only reports the ailment. `BrowserPreviewService` listens and calls
	 * `respawnPage` as part of a full rebuild.
	 */
	private requestRecovery(tabId: string, ailment: TabAilment): void {
		if (this.shuttingDown) return;

		const tab = this.tabs.get(tabId);
		if (!tab || tab.isDestroyed || tab.isRecovering) return;
		if (this.closingTabs.has(tabId)) return;

		const now = Date.now();
		const last = this.recoveryRequestedAt.get(tabId) ?? 0;
		if (now - last < RECOVERY_REQUEST_INTERVAL) return;
		this.recoveryRequestedAt.set(tabId, now);

		debug.warn('preview', `⚠️ Tab ${tabId}: ${ailment} — requesting a page rebuild`);
		this.emit('preview:browser-tab-unhealthy', { tabId, reason: ailment, timestamp: now });
	}

	/**
	 * Whether the tab can be driven right now. An unusable page schedules a
	 * rebuild rather than a close.
	 */
	private isValidTab(tabId: string): boolean {
		const tab = this.tabs.get(tabId);
		if (!tab) return false;

		if (tab.isDestroyed) {
			debug.warn('preview', `⚠️ Tab ${tabId}: already destroyed`);
			return false;
		}

		const ailment = this.diagnoseTab(tabId);
		if (!ailment) return true;

		this.requestRecovery(tabId, ailment);
		return false;
	}

	/**
	 * Rebuild the page behind an existing tab, keeping the tab itself.
	 *
	 * The id, the slot in the tab strip, the device size and the URL all
	 * survive; only `browser`/`context`/`page` are replaced. The pool relaunches
	 * Chrome on demand, so this covers a crashed renderer and a browser that
	 * went away entirely. Callers own the per-page state layered on top (console,
	 * navigation tracking, streaming scripts) and must re-apply it afterwards.
	 *
	 * Returns the tab, or null if it is gone / already being rebuilt.
	 */
	async respawnPage(tabId: string): Promise<BrowserTab | null> {
		const tab = this.tabs.get(tabId);
		if (!tab || tab.isDestroyed || tab.isRecovering) return null;
		if (this.closingTabs.has(tabId)) return null;

		tab.isRecovering = true;
		let pooled: PooledSession | null = null;

		try {
			const sessionId = this.getSessionId(tabId);

			// Before anything is asked of the context: its popup watcher closes
			// every page in it that is not the one this tab was built around,
			// which would include the replacement page it is about to open.
			this.detachTabListeners(tabId);

			// Keeps the context — and so the cookies and storage the tab has
			// built up — whenever the context itself survived.
			pooled = await browserPool.renewSessionPage(sessionId);
			const browser = await browserPool.getBrowser();

			tab.browser = browser;
			tab.context = pooled.context;
			tab.page = pooled.page;
			tab.isStreaming = false;
			tab.isCapturing = false;
			tab.lastFrameHash = undefined;
			tab.duplicateFrameCount = 0;
			// History belongs to the page that died; the new one starts over.
			tab.historyBaseIndex = undefined;
			tab.canGoBack = false;
			tab.canGoForward = false;

			await this.setupPage(pooled.page, tab.deviceSize, tab.rotation);

			const setupHook = this.tabSetupHooks.get(tabId);
			if (setupHook) {
				await setupHook(pooled.page, tabId);
			}

			this.setupBrowserHandlers(tabId, browser, pooled.context, pooled.page);

			// `url` over `currentUrl`: the navigation tracker keeps the former
			// current through redirects and SPA pushState, while the latter only
			// moves on an explicit navigate. Rebuilding from `currentUrl` would
			// drop a single-page app back to the route it was first opened at.
			const target = tab.url || tab.currentUrl || 'about:blank';
			const actualUrl = await this.navigateWithRetry(pooled.page, target);
			tab.url = actualUrl;
			tab.currentUrl = actualUrl;
			tab.isLoading = false;

			this.markTabActivity(tabId);
			this.recoveryRequestedAt.delete(tabId);

			debug.log('preview', `♻️ Tab ${tabId}: page rebuilt at ${actualUrl}`);

			return tab;
		} catch (error) {
			// Drop a half-built page rather than leave it in place: it would
			// have none of the instrumentation the tab needs, while reading as
			// perfectly healthy — so nothing would ever try again.
			if (pooled && !pooled.page.isClosed()) {
				await pooled.page.close().catch(() => {});
			}
			throw error;
		} finally {
			tab.isRecovering = false;
		}
	}

	/** Take a tab's browser- and context-level listeners back off. */
	private detachTabListeners(tabId: string): void {
		const entry = this.tabListeners.get(tabId);
		if (!entry) return;

		entry.browser.off('disconnected', entry.onDisconnected);
		entry.context.off('targetcreated', entry.onTargetCreated);
		this.tabListeners.delete(tabId);
	}

	/**
	 * Mark tab activity (prevent cleanup)
	 */
	markTabActivity(tabId: string): void {
		const now = Date.now();
		this.tabActivity.set(tabId, now);
	}

	/**
	 * Setup page (viewport, headers, injections)
	 */
	private async setupPage(page: Page, deviceSize: DeviceSize, rotation: Rotation) {
		// Get viewport dimensions from config
		const { width: viewportWidth, height: viewportHeight } = getViewportDimensions(deviceSize, rotation);

		await page.setViewport({ width: viewportWidth, height: viewportHeight });

		// Set page timeouts - more generous for stability
		page.setDefaultTimeout(30000);
		page.setDefaultNavigationTimeout(30000);

		// Configure page for stability
		// Note: Do NOT set HTTP headers manually here (like Accept-Language).
		// Setting extra headers alters the HTTP/2 pseudo-header order and capitalization
		// which immediately gets flagged by Cloudflare's TLS/Fingerprint matching algorithms.

		// Audio capture is injected post-navigation in BrowserVideoCapture.startStreaming()
		// to avoid Cloudflare fingerprint detection of AudioContext constructor patching.

		// Simplified cursor tracking for visual feedback only
		await this.injectCursorTracking(page);

		// Suppress Cloudflare Turnstile error callbacks to prevent sites from showing
		// "CAPTCHA verification failed" popups in headless Chrome (error 600010).
		//
		// Strategy: Let the real Turnstile script load and define window.turnstile normally
		// (needed for CF Managed Challenge auto-pass via StealthPlugin fingerprinting).
		// Intercept window.turnstile assignment via getter/setter and patch render()/execute()
		// to replace error-callback/expired-callback with no-ops before they are registered.
		// Also strip data-error-callback attributes from DOM elements via MutationObserver
		// to cover implicit render (data-sitekey) usage.
		//
		// This does NOT block challenges.cloudflare.com — CF Managed Challenge needs that
		// URL to run its JS verification. Only the error reporting path is suppressed.
		await page.evaluateOnNewDocument(function () {
			(function () {
				 
				let _turnstile: any;

				function patchOptions(options: Record<string, unknown>) {
					return Object.assign({}, options, {
						'error-callback': function () {},
						'expired-callback': function () {}
					});
				}

				 
				function patchApi(api: any) {
					if (!api || typeof api !== 'object') return api;
					['render', 'execute'].forEach(function (method: string) {
						if (typeof api[method] === 'function') {
							const orig = api[method].bind(api);
							api[method] = function (container: unknown, opts: Record<string, unknown>) {
								return orig(container, patchOptions(opts || {}));
							};
						}
					});
					return api;
				}

				try {
					Object.defineProperty(window, 'turnstile', {
						configurable: true,
						enumerable: true,
						 
						get() { return _turnstile; },
						 
						set(val: any) { _turnstile = patchApi(val); }
					});
				} catch {
					// Property already defined or can't be intercepted
				}

				// Strip data-error-callback / data-expired-callback from Turnstile elements
				// before implicit render reads them, so no error handler is registered.
				function stripErrorAttrs(el: Element) {
					el.removeAttribute('data-error-callback');
					el.removeAttribute('data-expired-callback');
				}

				const mo = new MutationObserver(function (mutations) {
					mutations.forEach(function (m) {
						m.addedNodes.forEach(function (node) {
							if (!(node instanceof Element)) return;
							if (node.hasAttribute('data-error-callback') || node.hasAttribute('data-expired-callback')) {
								stripErrorAttrs(node);
							}
							node.querySelectorAll('[data-error-callback],[data-expired-callback]').forEach(stripErrorAttrs);
						});
					});
				});
				if (document.documentElement) {
					mo.observe(document.documentElement, { childList: true, subtree: true });
				}
			})();
		});

		// NOTE: no `page.on('dialog')` here on purpose. Dialogs are owned by
		// BrowserDialogHandler, which forwards them to the viewer and renders a
		// real dialog there. Puppeteer hands a dialog to whichever listener
		// answers first, so an auto-dismiss registered at this point would win
		// every race and the user would never see alert()/confirm()/prompt().
		// The handler auto-dismisses on its own timeout if nobody is watching.
	}

	/**
	 * Inject cursor tracking script
	 */
	private async injectCursorTracking(page: Page) {
		// Temporarily disabled mapping logic as CloudFlare frequently flags evaluateOnNewDocument injected tracking events
		// await page.evaluateOnNewDocument(cursorTrackingScript);
	}

	/**
	 * Returns true for errors where retrying is pointless because the page/session is gone.
	 */
	private isNonRetryableError(error: unknown): boolean {
		if (error instanceof Error) {
			const msg = error.message;
			return (
				msg.includes('Session closed') ||
				msg.includes('detached Frame') ||
				error.constructor.name === 'TargetCloseError'
			);
		}
		return false;
	}

	/**
	 * Defensive cleanup before a URL reaches CDP.
	 *
	 * `Page.navigate` rejects with a bare "Cannot navigate to invalid URL" for
	 * strings that look completely valid to a person — the usual cause is a
	 * copy-paste artefact CDP does not tolerate: leading/trailing whitespace,
	 * a stray newline, or zero-width/invisible Unicode that a real address
	 * bar strips silently but Puppeteer never sees. `URL` is the same class of
	 * parser Chromium uses internally, so whatever it rejects would have
	 * failed identically inside the browser — surfacing that here, with the
	 * exact string, turns a dead end into something explainable instead of
	 * three pointless retries against a string that was never going anywhere.
	 */
	private sanitizeNavigationUrl(url: string): string {
		const cleaned = url.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '').trim();
		try {
			new URL(cleaned);
		} catch {
			throw new Error(`Invalid URL: "${cleaned}"`);
		}
		return cleaned;
	}

	/**
	 * Navigate with retry, including Cloudflare auto-pass detection and CAPTCHA popup dismissal.
	 */
	private async navigateWithRetry(page: Page, url: string): Promise<string> {
		const cleanUrl = this.sanitizeNavigationUrl(url);
		let retries = 3;
		let actualUrl = '';

		while (retries > 0) {
			try {
				await page.goto(cleanUrl, {
					waitUntil: 'domcontentloaded',
					timeout: 30000
				});
				actualUrl = await this.waitForCloudflareIfPresent(page);
				// Dismiss any CAPTCHA failure popups from embedded Turnstile widgets
				await this.dismissCaptchaPopupsIfPresent(page);
				break;
			} catch (error) {
				retries--;
				debug.warn('preview', `⚠️ Navigation failed, ${retries} retries left:`, error);
				if (retries === 0 || this.isNonRetryableError(error)) throw error;

				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		return actualUrl;
	}

	/**
	 * Detect Cloudflare challenge page and wait for auto-pass redirect.
	 * Loops up to MAX_CF_RETRIES times to handle infinite verify loops where
	 * Cloudflare keeps redirecting back to a new challenge after each pass.
	 */
	private async waitForCloudflareIfPresent(page: Page): Promise<string> {
		const MAX_CF_RETRIES = 5;

		for (let attempt = 0; attempt < MAX_CF_RETRIES; attempt++) {
			let isChallenge = false;

			try {
				isChallenge = await page.evaluate(() => {
					const title = document.title;
					const bodyText = (document.body?.innerText || '').slice(0, 500).toLowerCase();
					return (
						// Old automated CF challenge
						title === 'Just a moment...' ||
						// Newer interactive CF challenge ("Performing security verification")
						title.toLowerCase().includes('security verification') ||
						bodyText.includes('verify you are human') ||
						bodyText.includes('performing security verification') ||
						// CF challenge DOM elements (reliable, present on challenge pages only)
						document.getElementById('challenge-running') !== null ||
						document.getElementById('cf-challenge-running') !== null ||
						document.getElementById('challenge-form') !== null ||
						document.querySelector('#challenge-stage') !== null
					);
				});
			} catch {
				// Page not evaluable (navigating, closed) — not a CF challenge
				break;
			}

			if (!isChallenge) {
				break;
			}

			debug.log('preview', `🛡️ Cloudflare challenge detected (attempt ${attempt + 1}/${MAX_CF_RETRIES}), waiting for auto-pass...`);

			try {
				await page.waitForNavigation({
					waitUntil: 'domcontentloaded',
					timeout: 20000
				});
				debug.log('preview', `✅ Cloudflare navigation → ${page.url()}`);
			} catch {
				debug.warn('preview', `⚠️ Cloudflare auto-pass timed out on attempt ${attempt + 1}, proceeding`);
				break;
			}
		}

		return page.url();
	}

	/**
	 * Inject a persistent non-blocking watcher into the page that auto-dismisses
	 * CAPTCHA failure popups whenever they appear (Cloudflare Turnstile error 600010,
	 * reCAPTCHA failures, etc.).
	 *
	 * Uses MutationObserver + setInterval so it catches popups regardless of when they
	 * appear after page load. Returns immediately — the watcher runs inside the page.
	 */
	private async dismissCaptchaPopupsIfPresent(page: Page): Promise<void> {
		try {
			await page.evaluate(() => {
				const CAPTCHA_WORDS = ['captcha', 'turnstile', 'human verification', 'robot', 'bot detected'];
				const FAIL_WORDS = ['failed', 'error', 'invalid', 'verification failed', 'try again', 'unable to verify'];
				const DISMISS_LABELS = ['ok', 'close', 'dismiss', 'cancel', 'retry', 'try again', 'continue', 'got it'];

				const isCaptchaText = (text: string): boolean => {
					const t = text.toLowerCase();
					return (
						CAPTCHA_WORDS.some(w => t.includes(w)) &&
						FAIL_WORDS.some(w => t.includes(w))
					);
				};

				const tryDismiss = (): boolean => {
					// Strategy 1: click a dismiss button whose ancestor contains CAPTCHA failure text
					const buttons = Array.from(document.querySelectorAll<HTMLElement>(
						'button, input[type="button"], input[type="submit"], a[role="button"]'
					));
					for (const btn of buttons) {
						const label = (
							btn instanceof HTMLInputElement ? btn.value : btn.innerText || btn.textContent || ''
						).trim().toLowerCase();
						if (!DISMISS_LABELS.includes(label)) continue;

						let el: Element | null = btn.parentElement;
						while (el && el !== document.body) {
							if (isCaptchaText((el as HTMLElement).innerText || '')) {
								(btn as HTMLElement).click();
								return true;
							}
							el = el.parentElement;
						}
					}

					// Strategy 2: hide any visible modal/overlay containing CAPTCHA failure text
					const overlaySelectors = [
						'[class*="modal"]', '[class*="popup"]', '[class*="dialog"]',
						'[class*="overlay"]', '[class*="alert"]', '[class*="notification"]',
						'[role="dialog"]', '[role="alertdialog"]', '[role="alert"]'
					];
					const overlays = document.querySelectorAll<HTMLElement>(overlaySelectors.join(','));
					for (const overlay of overlays) {
						if (!isCaptchaText(overlay.innerText || '')) continue;
						const style = overlay.style;
						if (style.display === 'none' || style.visibility === 'hidden') continue;

						// Try clicking a close button first
						const closeBtn = overlay.querySelector<HTMLElement>(
							'button, [class*="close"], [aria-label*="lose"], [aria-label*="ismiss"]'
						);
						if (closeBtn) {
							closeBtn.click();
						} else {
							style.display = 'none';
						}
						return true;
					}

					return false;
				};

				// Run immediately in case popup is already present
				if (tryDismiss()) return;

				// Set up persistent watcher — fires on any DOM mutation
				const observer = new MutationObserver(() => {
					if (tryDismiss()) {
						observer.disconnect();
						clearInterval(ticker);
					}
				});

				// Also poll via interval as safety net (MutationObserver may miss text changes)
				const ticker = setInterval(() => {
					if (tryDismiss()) {
						clearInterval(ticker);
						observer.disconnect();
					}
				}, 400);

				if (document.body) {
					observer.observe(document.body, { childList: true, subtree: true, characterData: true });
				}

				// Self-cleanup after 30 seconds to avoid memory leaks
				setTimeout(() => {
					observer.disconnect();
					clearInterval(ticker);
				}, 30000);
			});

			debug.log('preview', '🔔 CAPTCHA auto-dismiss watcher injected into page');
		} catch {
			// Page closed or navigated away — ignore
		}
	}

	/**
	 * Setup browser event handlers
	 */
	private setupBrowserHandlers(tabId: string, browser: Browser, context: BrowserContext, page: Page) {
		// Chrome went away — a crash, an OOM kill, a machine that slept. The tab
		// is not: the pool launches a new browser on demand, so ask for a rebuild
		// instead of deleting a tab the user never closed.
		const onDisconnected = () => {
			this.requestRecovery(tabId, 'browser-gone');
		};

		// Puppeteer raises this when the renderer crashes. Long-running previews
		// hit it on low-memory hosts, and it used to be terminal for the tab.
		page.on('error', (error) => {
			debug.error('preview', `💥 Page crashed for tab ${tabId}: ${error.message}`);
			this.requestRecovery(tabId, 'page-gone');
		});

		// The page can also go away without an error — a site calling
		// window.close(), a target Chrome dropped. Same answer: rebuild it.
		// Our own teardown paths hold the closing/recovering flags that
		// requestRecovery checks, so this never fights them.
		page.on('close', () => {
			debug.warn('preview', `⚠️ Page close event for tab ${tabId}`);
			this.requestRecovery(tabId, 'page-gone');
		});

		// Handle popup/new window events within this context
		const onTargetCreated = async (target: Target) => {
			if (target.type() === 'page') {
				const newPage = await target.page();
				if (newPage && newPage !== page) {
					const popupUrl = newPage.url();

					// Emit event for frontend to handle
					this.emit('new-window', {
						tabId,
						url: popupUrl,
						timestamp: Date.now()
					});

					// Close the popup to prevent resource leak
					try {
						await newPage.close();
					} catch (error) {
						debug.warn('preview', 'Failed to close popup:', error);
					}
				}
			}
		};

		// Registered together so a rebuild can lift both at once, before the
		// context is asked for the page that replaces this one.
		this.detachTabListeners(tabId);
		browser.on('disconnected', onDisconnected);
		context.on('targetcreated', onTargetCreated);
		this.tabListeners.set(tabId, { browser, onDisconnected, context, onTargetCreated });
	}

	/**
	 * Clean up the isolated context for a tab
	 */
	private async cleanupContext(tab: BrowserTab) {
		try {
			// Close the page first
			if (tab.page && !tab.page.isClosed()) {
				await tab.page.close().catch((error) =>
					debug.warn('preview', `⚠️ Error closing page:`, error instanceof Error ? error.message : error)
				);
			}

			// Destroy the isolated session via browser pool (use project-scoped sessionId)
			const sessionId = this.getSessionId(tab.id);
			await browserPool.destroySession(sessionId);
		} catch (error) {
			debug.warn('preview', `⚠️ Error during context cleanup for ${tab.id}:`, error instanceof Error ? error.message : error);
		}
	}

	/**
	 * Helper: Get title from URL
	 */
	private getTitleFromUrl(url: string): string {
		if (!url || url === 'about:blank') return 'New Tab';
		try {
			return new URL(url).hostname;
		} catch {
			return url.length > 30 ? url.slice(0, 30) + '...' : url;
		}
	}

	/**
	 * Initialize periodic cleanup of inactive tabs
	 */
	private initializeCleanup(): void {
		// Don't initialize twice
		if (this.cleanupInterval) {
			return;
		}

		// Start periodic cleanup
		this.cleanupInterval = setInterval(() => {
			this.performCleanup();
		}, CLEANUP_INTERVAL);

		// Cleanup on shutdown — track references so we can remove them later
		// and prevent duplicate listeners if multiple BrowserTabManager
		// instances are created.
		const cleanup = () => {
			this.shuttingDown = true;
			if (this.cleanupInterval) clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
			this.tabActivity.clear();
			this.removeSignalHandlers();
		};

		this.signalHandlers = { sigterm: cleanup, sigint: cleanup };
		process.on('SIGTERM', this.signalHandlers.sigterm);
		process.on('SIGINT', this.signalHandlers.sigint);
	}

	/**
	 * Remove previously registered signal handlers to prevent leaks
	 * when multiple BrowserTabManager instances are created.
	 */
	private removeSignalHandlers(): void {
		if (!this.signalHandlers) return;
		process.off('SIGTERM', this.signalHandlers.sigterm);
		process.off('SIGINT', this.signalHandlers.sigint);
		this.signalHandlers = null;
	}

	/**
	 * Reap bookkeeping left behind by a close that did not finish.
	 *
	 * The only thing this may remove is a tab already marked destroyed with no
	 * close in flight — i.e. an entry whose teardown threw halfway. A tab whose
	 * page merely died is NOT reaped: it is rebuilt on next use, and closing it
	 * here is exactly the silent disappearance this sweep used to cause.
	 */
	private performCleanup(): void {
		const now = Date.now();

		for (const [tabId, tab] of this.tabs.entries()) {
			const lastActivity = this.tabActivity.get(tabId);

			// If no activity recorded, mark it as active now and skip cleanup
			if (!lastActivity) {
				this.tabActivity.set(tabId, now);
				continue;
			}

			const inactiveTime = now - lastActivity;

			// Skip if tab has recent activity
			if (inactiveTime < INACTIVE_TIMEOUT) {
				continue;
			}

			if (tab.isDestroyed && !this.closingTabs.has(tabId)) {
				debug.log('preview', `🧹 Reaping half-closed tab: ${tabId} (idle for ${Math.round(inactiveTime / 1000)}s)`);
				this.closeTab(tabId).catch(console.error);
			}
		}
	}

	/**
	 * Cleanup inactive tabs
	 */
	async cleanupInactiveTabs() {
		const tabIds = Array.from(this.tabs.keys());
		const inactiveTabs: string[] = [];
		const activeTabs: string[] = [];

		// Categorize tabs by activity
		for (const tabId of tabIds) {
			const tab = this.tabs.get(tabId);
			if (!tab) {
				inactiveTabs.push(tabId);
				continue;
			}

			// Truly inactive means the page is gone, not that nobody is
			// watching: a tab whose panel is closed or minimized is not
			// streaming and is perfectly alive. Treating that as a zombie is
			// what let the "SAFE" mode take out tabs it promised to preserve.
			const isInactive = tab.isDestroyed || (!tab.isRecovering && this.diagnoseTab(tabId) !== null);

			if (isInactive) {
				inactiveTabs.push(tabId);
			} else {
				activeTabs.push(tabId);
			}
		}

		// Only cleanup inactive tabs
		if (inactiveTabs.length > 0) {
			const cleanupPromises = inactiveTabs.map(tabId =>
				this.closeTab(tabId).catch(error =>
					debug.warn('preview', `⚠️ Error destroying inactive tab ${tabId}:`, error)
				)
			);

			try {
				await Promise.race([
					Promise.all(cleanupPromises),
					new Promise((_, reject) => setTimeout(() => reject(new Error('Inactive tab cleanup timeout')), 10000))
				]);
			} catch (error) {
				debug.warn('preview', '⚠️ Inactive tab cleanup timeout:', error);
			}
		}

		return {
			activeTabsCount: activeTabs.length,
			inactiveTabsDestroyed: inactiveTabs.length,
			activeTabs,
			cleanedTabs: inactiveTabs
		};
	}

	/**
	 * Cleanup all tabs
	 */
	async cleanup(): Promise<void> {
		debug.log('preview', `🧹 Cleaning up ${this.tabs.size} tabs...`);

		// Every page below is about to be closed on purpose; none of them is a
		// crash to rebuild from. Restored at the end: an admin "clean up all"
		// leaves the manager in service, and the tabs opened after it must be
		// able to recover like any other.
		const wasShuttingDown = this.shuttingDown;
		this.shuttingDown = true;

		// Stop cleanup interval
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

		// Remove signal handlers to prevent leaks
		this.removeSignalHandlers();

		const tabIds = Array.from(this.tabs.keys());

		if (tabIds.length > 0) {
			debug.log('preview', `🗑️ Destroying ${tabIds.length} tabs...`);

			// Destroy all tabs in parallel
			const cleanupPromises = tabIds.map((tabId) =>
				this.closeTab(tabId).catch((error) => debug.warn('preview', `⚠️ Error destroying tab ${tabId}:`, error))
			);

			try {
				await Promise.race([
					Promise.all(cleanupPromises),
					new Promise((_, reject) => setTimeout(() => reject(new Error('Tab cleanup timeout')), 15000))
				]);
			} catch (error) {
				debug.warn('preview', '⚠️ Tab cleanup timeout:', error);
			}
		}

		// Force clear tabs map
		for (const tabId of this.tabs.keys()) this.detachTabListeners(tabId);
		this.tabs.clear();
		this.activeTabId = null;
		this.tabActivity.clear();
		this.tabSetupHooks.clear();
		this.recoveryRequestedAt.clear();

		this.shuttingDown = wasShuttingDown;

		// Deliberately NOT browserPool.cleanup(): the pool holds one Chrome and
		// every project's contexts. Closing it from one workspace's teardown —
		// deleting a worktree, an admin "clean up all" — took every other
		// project's preview tabs down with it. Our own sessions are already gone
		// with the tabs above; the pool closes its browser when the last session
		// goes, and on process shutdown.

		debug.log('preview', '✅ All tabs cleaned up');
	}

	/**
	 * Get all tab IDs
	 */
	getAvailableTabIds(): string[] {
		return Array.from(this.tabs.keys());
	}
}
