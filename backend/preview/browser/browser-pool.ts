/**
 * Browser Pool Module
 *
 * Uses puppeteer-extra with StealthPlugin for Cloudflare bypass.
 * Architecture mirrors the working test-cf.ts approach:
 * - Single shared browser launched directly via puppeteer.launch()
 * - Isolated BrowserContext per session (separate cookies, storage, cache)
 * - StealthPlugin applied at launch time (via puppeteer-extra hooks)
 *
 * Why not puppeteer-cluster?
 * - Cluster's CONCURRENCY_CONTEXT mode accesses the browser via the raw
 *   underlying reference, bypassing puppeteer-extra's page creation hooks.
 * - This causes a race condition where stealth evasions (evaluateOnNewDocument)
 *   may not be registered before the first navigation, breaking Cloudflare bypass.
 * - Direct launch() ensures puppeteer-extra wraps ALL page creation correctly.
 */

import { existsSync } from 'fs';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { debug } from '$shared/utils/logger';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getChromeExecutablePath } from '$backend/engine/install-recipes';

puppeteer.use(StealthPlugin());

export interface PoolConfig {
	maxConcurrency: number;
	timeout: number;
	retryLimit: number;
	retryDelay: number;
}

export interface PooledSession {
	context: BrowserContext;
	page: Page;
	createdAt: number;
	sessionId: string;
}

const DEFAULT_CONFIG: PoolConfig = {
	maxConcurrency: 50,
	timeout: 60000,
	retryLimit: 3,
	retryDelay: 1000
};

/**
 * Chrome launch arguments.
 *
 * Three groups, kept separate because they answer different questions:
 * stealth (Cloudflare bypass — matches test-cf.ts), capture (what the preview
 * pipeline needs from the renderer), and host adaptation (what a headless VPS
 * needs that a desktop doesn't).
 */
function buildChromeArgs(): string[] {
	// Chrome only honours the last `--disable-features`, so every entry has to
	// live in one combined flag.
	const disabledFeatures = [
		'AudioServiceOutOfProcess',
		'WebRtcHideLocalIpsWithMdns',
		// Occlusion detection throttles renderers Chrome thinks nobody is
		// looking at — which is every headless tab, including the one we are
		// actively streaming.
		'CalculateNativeWinOcclusion'
	];

	const args = [
		'--no-sandbox',
		'--disable-blink-features=AutomationControlled',
		'--window-size=1366,768',
		'--autoplay-policy=no-user-gesture-required',

		// In-page capture (getDisplayMedia({preferCurrentTab})) — lets the
		// encoder read compositor frames directly instead of round-tripping
		// JPEG through CDP. Without this the call would wait on a picker that
		// can never be answered in headless.
		'--auto-accept-this-tab-capture',

		// A headless tab is never "visible" or "focused", and Chrome
		// aggressively de-prioritises renderers in that state — timers get
		// clamped and compositing stalls, which reads as a frozen preview.
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',

		// Containers and small VPS instances often ship a 64MB /dev/shm;
		// exceeding it crashes the renderer mid-stream.
		'--disable-dev-shm-usage',

		'--no-first-run',
		'--no-default-browser-check',
		'--disable-hang-monitor',
		'--metrics-recording-only',
		'--force-color-profile=srgb'
	];

	if (shouldDisableGpu()) {
		// Without a real GPU, Chrome falls back to SwiftShader — a software
		// GL implementation whose setup and per-frame cost exceed plain CPU
		// rasterisation for the 2D content a preview shows.
		args.push('--disable-gpu', '--disable-software-rasterizer');
	}

	args.push(`--disable-features=${disabledFeatures.join(',')}`);

	return args;
}

/**
 * Whether this host benefits from skipping GPU compositing entirely.
 *
 * `auto` only disables it on Linux hosts with no render node, i.e. headless
 * servers — a Linux desktop keeps its GPU so WebGL previews still work.
 */
function shouldDisableGpu(): boolean {
	const override = (process.env.CLOPEN_PREVIEW_GPU || '').trim().toLowerCase();
	if (override === 'off') return true;
	if (override === 'on') return false;

	if (process.platform !== 'linux') return false;

	try {
		return !existsSync('/dev/dri');
	} catch {
		return true;
	}
}

const CHROME_ARGS = buildChromeArgs();

class BrowserPool {
	private browser: Browser | null = null;
	private sessions = new Map<string, PooledSession>();
	private config: PoolConfig;
	private isLaunching = false;
	private launchPromise: Promise<Browser> | null = null;

	constructor(config: Partial<PoolConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Get or create the shared browser instance.
	 * Uses puppeteer-extra directly (same as test-cf.ts) to ensure
	 * StealthPlugin hooks fire for every page created.
	 */
	async getBrowser(): Promise<Browser> {
		if (this.browser?.connected) {
			return this.browser;
		}

		if (this.isLaunching && this.launchPromise) {
			return this.launchPromise;
		}

		this.isLaunching = true;
		this.launchPromise = this.launchBrowser();

		try {
			this.browser = await this.launchPromise;
			return this.browser;
		} finally {
			this.isLaunching = false;
			this.launchPromise = null;
		}
	}

	/**
	 * Launch browser via puppeteer-extra (with StealthPlugin already registered).
	 * This matches test-cf.ts which successfully bypasses Cloudflare.
	 */
	private async launchBrowser(): Promise<Browser> {
		debug.log('preview', '🚀 Launching browser with puppeteer-extra + StealthPlugin...');

		// Use the clopen-managed Chrome for Testing under ~/.clopen/bin
		// (macOS/Windows) or the system Google Chrome / chromium installed
		// via the distro package manager (Linux).
		const executablePath = getChromeExecutablePath();
		if (!executablePath) {
			throw new Error('Chrome not installed. Go to Settings → Stack and click Install.');
		}
		debug.log('preview', `  using Chrome at: ${executablePath}`);

		const browser = await puppeteer.launch({
			headless: true,
			executablePath,
			args: CHROME_ARGS
		}) as unknown as Browser;

		debug.log('preview', '✅ Browser launched successfully');

		// Handle browser disconnection
		browser.on('disconnected', () => {
			debug.warn('preview', '⚠️ Browser disconnected');
			this.browser = null;
			// Close all sessions since browser is gone
			this.sessions.clear();
		});

		return browser;
	}

	/**
	 * Create an isolated session with its own BrowserContext.
	 * Each context has separate cookies, localStorage, sessionStorage, and cache.
	 */
	async createSession(sessionId: string): Promise<PooledSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			debug.log('preview', `♻️ Reusing existing session: ${sessionId}`);
			return existing;
		}

		debug.log('preview', `🔒 Creating isolated session: ${sessionId}`);

		const browser = await this.getBrowser();

		// Create isolated context — puppeteer-extra wraps this correctly
		// so StealthPlugin's onPageCreated fires for every page in this context
		const context = await browser.createBrowserContext();
		const page = await context.newPage();

		const session: PooledSession = {
			context,
			page,
			createdAt: Date.now(),
			sessionId
		};

		this.sessions.set(sessionId, session);

		debug.log('preview', `✅ Session created: ${sessionId} (total: ${this.sessions.size})`);

		return session;
	}

	/**
	 * Get an existing session
	 */
	getSession(sessionId: string): PooledSession | null {
		return this.sessions.get(sessionId) ?? null;
	}

	/**
	 * Get the browser context for a session
	 */
	getContext(sessionId: string): BrowserContext | null {
		return this.sessions.get(sessionId)?.context ?? null;
	}

	/**
	 * Destroy a session and clean up all its resources
	 */
	async destroySession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		debug.log('preview', `🗑️ Destroying session: ${sessionId}`);

		try {
			if (session.page && !session.page.isClosed()) {
				await session.page.close().catch((err: Error) => {
					debug.warn('preview', `Error closing page: ${err.message}`);
				});
			}

			await session.context.close().catch((err: Error) => {
				debug.warn('preview', `Error closing context: ${err.message}`);
			});
		} catch (error) {
			debug.warn('preview', `⚠️ Error destroying session: ${error}`);
		}

		this.sessions.delete(sessionId);
		debug.log('preview', `✅ Session destroyed (remaining: ${this.sessions.size})`);
	}

	/**
	 * Check if a session is valid
	 */
	isSessionValid(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;
		if (session.page.isClosed()) return false;
		return true;
	}

	/**
	 * Get pool statistics
	 */
	getStats() {
		return {
			browserConnected: this.browser?.connected ?? false,
			activeSessions: this.sessions.size,
			maxConcurrency: this.config.maxConcurrency,
			sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
				sessionId: id,
				createdAt: session.createdAt,
				ageMs: Date.now() - session.createdAt,
				pageOpen: !session.page.isClosed()
			}))
		};
	}

	/**
	 * Clean up all resources
	 */
	async cleanup(): Promise<void> {
		debug.log('preview', '🧹 Cleaning up browser pool...');

		const sessionIds = Array.from(this.sessions.keys());
		await Promise.all(sessionIds.map((id) => this.destroySession(id)));

		if (this.browser) {
			try {
				await this.browser.close();
			} catch (error) {
				debug.warn('preview', `⚠️ Error closing browser: ${error}`);
			}
			this.browser = null;
		}

		debug.log('preview', '✅ Browser pool cleaned up');
	}
}

// Singleton instance
export const browserPool = new BrowserPool();

// Graceful shutdown handlers
const gracefulShutdown = async (signal: string) => {
	debug.log('preview', `Received ${signal}, cleaning up...`);
	await browserPool.cleanup();
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
