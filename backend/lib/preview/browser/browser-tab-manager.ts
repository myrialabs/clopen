import type { Browser, BrowserContext, Page } from 'puppeteer';
import { EventEmitter } from 'events';
import { getViewportDimensions } from '$frontend/lib/constants/preview.js';
import type { BrowserTab, BrowserTabInfo, DeviceSize, Rotation } from './types';
import { DEFAULT_STREAMING_CONFIG } from './types';
import { browserPool } from './browser-pool';
import { BrowserAudioCapture } from './browser-audio-capture';
import { cursorTrackingScript } from './scripts/cursor-tracking';
import { browserMcpControl } from './browser-mcp-control';
import { debug } from '$shared/utils/logger';

// Tab cleanup configuration
const INACTIVE_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const CLEANUP_INTERVAL = 60 * 1000; // Check every minute

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
			preNavigationSetup?: (page: Page) => Promise<void>;
		}
	): Promise<BrowserTab> {
		const tabId = `tab-${this.nextTabNumber++}`;
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
			await options.preNavigationSetup(page);
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

		debug.log('preview', `🗑️ Closing tab: ${tabId}`);

		const wasActive = tab.isActive;

		// Auto-release MCP control if this tab is being controlled
		browserMcpControl.autoReleaseForTab(tabId);

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
		this.tabs.delete(tabId);
		this.tabActivity.delete(tabId);

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
			quality: tab.quality,
			isStreaming: tab.isStreaming,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			isActive: tab.isActive
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
			quality: tab.quality,
			isStreaming: tab.isStreaming,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			isActive: tab.isActive
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
			pageClosed: tab.page?.isClosed() || true,
			deviceSize: tab.deviceSize,
			rotation: tab.rotation,
			consoleLogs: tab.consoleLogs.length,
			lastInteractionTime: tab.lastInteractionTime,
			duplicateFrameCount: tab.duplicateFrameCount || 0,
			isActive: tab.isActive,
			createdAt: tab.createdAt,
			lastAccessedAt: tab.lastAccessedAt
		}));

		return {
			totalTabs: tabs.length,
			activeTabs: tabs.filter(t => t.isStreaming && t.browserConnected && !t.pageClosed && !t.isDestroyed).length,
			inactiveTabs: tabs.filter(t => t.isDestroyed || !t.browserConnected || t.pageClosed || !t.isStreaming).length,
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
	 * Validate tab
	 */
	private isValidTab(tabId: string): boolean {
		const tab = this.tabs.get(tabId);
		if (!tab) {
			return false;
		}

		// Check if tab is already destroyed
		if (tab.isDestroyed) {
			debug.warn('preview', `⚠️ Tab ${tabId}: already destroyed`);
			return false;
		}

		// Check if browser is still connected (shared browser)
		if (!tab.browser || !tab.browser.connected) {
			debug.warn('preview', `⚠️ Tab ${tabId}: shared browser disconnected`);
			this.closeTab(tabId).catch(console.error);
			return false;
		}

		// Check if session is still valid in the pool (use project-scoped sessionId)
		const sessionId = this.getSessionId(tabId);
		const isPoolValid = browserPool.isSessionValid(sessionId);
		if (!isPoolValid) {
			debug.warn('preview', `⚠️ Tab ${tabId}: session no longer valid in pool`);
			this.closeTab(tabId).catch(console.error);
			return false;
		}

		// Check if page is still open
		if (!tab.page || tab.page.isClosed()) {
			debug.warn('preview', `⚠️ Tab ${tabId}: page closed`);
			this.closeTab(tabId).catch(console.error);
			return false;
		}

		return true;
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
		await page.setExtraHTTPHeaders({
			'Accept-Language': 'en-US,en;q=0.9',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		});

		// Optimize font loading to prevent screenshot timeouts
		await page.evaluateOnNewDocument(() => {
			// Disable font loading wait
			Object.defineProperty(document, 'fonts', {
				value: {
					ready: Promise.resolve(),
					load: () => Promise.resolve([]),
					check: () => true,
					addEventListener: () => {},
					removeEventListener: () => {}
				}
			});
		});

		// Inject audio capture script BEFORE page loads to intercept AudioContext
		await this.audioCapture.setupAudioCapture(page, DEFAULT_STREAMING_CONFIG.audio);

		// Simplified cursor tracking for visual feedback only
		await this.injectCursorTracking(page);
	}

	/**
	 * Inject cursor tracking script
	 */
	private async injectCursorTracking(page: Page) {
		await page.evaluateOnNewDocument(cursorTrackingScript);
	}

	/**
	 * Navigate with retry
	 */
	private async navigateWithRetry(page: Page, url: string): Promise<string> {
		let retries = 3;
		let actualUrl = '';

		while (retries > 0) {
			try {
				await page.goto(url, {
					waitUntil: 'domcontentloaded',
					timeout: 30000
				});
				actualUrl = page.url();
				break;
			} catch (error) {
				retries--;
				debug.warn('preview', `⚠️ Navigation failed, ${retries} retries left:`, error);
				if (retries === 0) throw error;

				// Wait before retry
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		return actualUrl;
	}

	/**
	 * Setup browser event handlers
	 */
	private setupBrowserHandlers(tabId: string, browser: Browser, context: BrowserContext, page: Page) {
		// Add error handlers for browser disconnection
		// Note: With shared browser, we only clean up THIS tab, not close the browser
		browser.on('disconnected', () => {
			const tab = this.tabs.get(tabId);
			if (tab && !tab.isDestroyed) {
				debug.warn('preview', `⚠️ Shared browser disconnected, cleaning up tab ${tabId}`);
				tab.isDestroyed = true;
				this.closeTab(tabId).catch(console.error);
			}
		});

		// Handle page errors
		page.on('error', (error) => {
			const tab = this.tabs.get(tabId);
			if (tab && !tab.isDestroyed) {
				debug.error('preview', `💥 Page error for tab ${tabId}: ${error.message}, cleaning up`);
				tab.isDestroyed = true;
				this.closeTab(tabId).catch(console.error);
			}
		});

		// Track page close event
		page.on('close', () => {
			debug.warn('preview', `⚠️ Page close event for tab ${tabId}`);
		});

		// Handle popup/new window events within this context
		context.on('targetcreated', async (target) => {
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
		});
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

		// Cleanup on shutdown
		const cleanup = () => {
			if (this.cleanupInterval) clearInterval(this.cleanupInterval);
			this.tabActivity.clear();
		};

		process.on('SIGTERM', cleanup);
		process.on('SIGINT', cleanup);
	}

	/**
	 * Perform cleanup of inactive tabs
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

			// Only cleanup if tab is truly orphaned
			if (tab.isDestroyed || (tab.page?.isClosed() && !tab.browser?.connected)) {
				debug.log('preview', `🧹 Auto-cleaning up inactive tab: ${tabId} (inactive for ${Math.round(inactiveTime / 1000)}s)`);

				// Close tab
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

			// Check if tab is truly inactive
			const isInactive =
				tab.isDestroyed ||
				!tab.browser?.connected ||
				tab.page?.isClosed() ||
				!tab.isStreaming;

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

		// Stop cleanup interval
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}

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
		this.tabs.clear();
		this.activeTabId = null;
		this.tabActivity.clear();

		// Clean up the browser pool (closes all contexts and the shared browser)
		await browserPool.cleanup();

		debug.log('preview', '✅ All tabs cleaned up');
	}

	/**
	 * Get all tab IDs
	 */
	getAvailableTabIds(): string[] {
		return Array.from(this.tabs.keys());
	}
}
