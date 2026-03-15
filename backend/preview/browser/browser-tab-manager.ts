import type { Browser, BrowserContext, Page } from 'puppeteer';
import { EventEmitter } from 'events';
import { getViewportDimensions } from '$frontend/utils/preview-constants.js';
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

		// Auto-dismiss native browser dialogs to prevent page hang in headless mode.
		// alert() → accept (one-way informational, safe to dismiss)
		// confirm()/prompt() → dismiss/cancel (avoid unintended side effects)
		// CAPTCHA-related alerts are silently dismissed.
		page.on('dialog', async (dialog) => {
			const type = dialog.type();
			if (type === 'alert') {
				await dialog.accept().catch(() => {});
			} else {
				await dialog.dismiss().catch(() => {});
			}
		});
	}

	/**
	 * Inject cursor tracking script
	 */
	private async injectCursorTracking(page: Page) {
		// Temporarily disabled mapping logic as CloudFlare frequently flags evaluateOnNewDocument injected tracking events
		// await page.evaluateOnNewDocument(cursorTrackingScript);
	}

	/**
	 * Navigate with retry, including Cloudflare auto-pass detection and CAPTCHA popup dismissal.
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
				actualUrl = await this.waitForCloudflareIfPresent(page);
				// Dismiss any CAPTCHA failure popups from embedded Turnstile widgets
				await this.dismissCaptchaPopupsIfPresent(page);
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
