/**
 * Browser Pool Module using puppeteer-cluster
 *
 * Uses puppeteer-cluster for efficient browser management with isolated contexts.
 *
 * Architecture:
 * - puppeteer-cluster manages browser lifecycle and crash recovery
 * - CONCURRENCY_CONTEXT mode: shared browser, isolated contexts per worker
 * - Each user session gets its own isolated BrowserContext
 *
 * Isolation per session:
 * - Separate cookies
 * - Separate localStorage/sessionStorage
 * - Separate cache
 * - Separate service workers
 * - No data leakage between users
 *
 * Memory Usage:
 * - 1 user: ~300MB (browser) + ~20MB (context) = ~320MB
 * - 10 users: ~300MB (browser) + ~200MB (contexts) = ~500MB
 * - vs. old: 10 users = 10 browsers = 2-5GB
 */

import { Cluster } from 'puppeteer-cluster';
import type { Browser, BrowserContext, Page } from 'puppeteer';
import { debug } from '$shared/utils/logger';

export interface PoolConfig {
	maxConcurrency: number; // Maximum concurrent isolated contexts
	timeout: number; // Task timeout
	retryLimit: number; // Number of retries on failure
	retryDelay: number; // Delay between retries
}

export interface PooledSession {
	context: BrowserContext;
	page: Page;
	createdAt: number;
	sessionId: string;
}

const DEFAULT_CONFIG: PoolConfig = {
	maxConcurrency: 50, // Support up to 50 concurrent users
	timeout: 60000, // 60 second timeout
	retryLimit: 3, // Retry 3 times on failure
	retryDelay: 1000 // 1 second delay between retries
};

/**
 * Optimized Chromium launch arguments for low-resource usage
 */
const CHROMIUM_ARGS = [
	// === CORE STABILITY (Windows compatible) ===
	'--no-sandbox',
	'--disable-dev-shm-usage',
	'--disable-gpu',

	// === PREVENT THROTTLING ===
	'--disable-background-timer-throttling',
	'--disable-backgrounding-occluded-windows',
	'--disable-renderer-backgrounding',

	// === DISABLE UNNECESSARY FEATURES ===
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-extensions',
	'--disable-popup-blocking',

	// === LOW-END DEVICE OPTIMIZATIONS ===
	'--memory-pressure-off',
	'--disable-features=TranslateUI',
	'--disable-sync',
	'--disable-domain-reliability',
	'--disable-client-side-phishing-detection',
	'--disable-software-rasterizer',
	'--disable-smooth-scrolling',
	'--disable-threaded-animation',
	'--disable-threaded-scrolling',
	'--disable-composited-antialiasing',
	'--disable-webgl',
	'--disable-webgl2',
	'--disable-accelerated-2d-canvas',
	'--disable-gpu-vsync',
	'--disable-ipc-flooding-protection',

	// === AUDIO SUPPORT ===
	'--autoplay-policy=no-user-gesture-required',
	'--use-fake-ui-for-media-stream'
];

class BrowserPool {
	private cluster: Cluster | null = null;
	private sessions = new Map<string, PooledSession>();
	private config: PoolConfig;
	private isInitializing = false;
	private initPromise: Promise<Cluster> | null = null;

	constructor(config: Partial<PoolConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Get or create the puppeteer-cluster instance
	 * Thread-safe: multiple calls during initialization will wait for the same promise
	 */
	async getCluster(): Promise<Cluster> {
		if (this.cluster) {
			return this.cluster;
		}

		if (this.isInitializing && this.initPromise) {
			return this.initPromise;
		}

		this.isInitializing = true;
		this.initPromise = this.launchCluster();

		try {
			this.cluster = await this.initPromise;
			return this.cluster;
		} finally {
			this.isInitializing = false;
			this.initPromise = null;
		}
	}

	/**
	 * Launch puppeteer-cluster with CONCURRENCY_CONTEXT for isolation
	 */
	private async launchCluster(): Promise<Cluster> {
		debug.log('preview', '🚀 Launching puppeteer-cluster...');

		const cluster = await Cluster.launch({
			// CONCURRENCY_CONTEXT: shared browser, isolated context per worker
			// Each context has its own cookies, localStorage, sessionStorage, cache
			concurrency: Cluster.CONCURRENCY_CONTEXT,
			maxConcurrency: this.config.maxConcurrency,
			timeout: this.config.timeout,
			retryLimit: this.config.retryLimit,
			retryDelay: this.config.retryDelay,

			puppeteerOptions: {
				headless: true,
				args: CHROMIUM_ARGS
			},

			// Monitor events
			monitor: false // Disable built-in monitoring, we use our own logging
		});

		// Handle cluster errors
		cluster.on('taskerror', (err, data) => {
			debug.error('preview', `Task error for session ${data?.sessionId}:`, err.message);
		});

		debug.log('preview', '✅ puppeteer-cluster launched successfully');
		debug.log('preview', `📊 Max concurrency: ${this.config.maxConcurrency}`);

		return cluster;
	}

	/**
	 * Get the shared browser instance from the cluster
	 * Note: This accesses the internal browser - use with caution
	 */
	async getBrowser(): Promise<Browser> {
		const cluster = await this.getCluster();

		// Access the browser through a dummy task
		// This is a workaround since cluster doesn't expose browser directly
		return new Promise((resolve, reject) => {
			cluster
				.execute(async ({ page }: { page: Page }) => {
					const browser = page.browser();
					resolve(browser);
				})
				.catch(reject);
		});
	}

	/**
	 * Create an isolated session with its own BrowserContext
	 * Uses puppeteer-cluster's task execution for proper resource management
	 */
	async createSession(sessionId: string): Promise<PooledSession> {
		// Check if session already exists
		const existing = this.sessions.get(sessionId);
		if (existing) {
			debug.log('preview', `♻️ Reusing existing session: ${sessionId}`);
			return existing;
		}

		debug.log('preview', `🔒 Creating isolated session: ${sessionId}`);

		const cluster = await this.getCluster();
		const browser = await this.getBrowser();

		// Create isolated BrowserContext for this session
		// This provides FULL ISOLATION: cookies, localStorage, sessionStorage, cache
		// When sessionId is prefixed with projectId (e.g., "project123:tab-1"),
		// this ensures complete isolation between projects
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
			// Close the page first
			if (session.page && !session.page.isClosed()) {
				await session.page.close().catch((err: Error) => {
					debug.warn('preview', `Error closing page: ${err.message}`);
				});
			}

			// Close the context (this clears all cookies, storage, cache)
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
	 * Execute a task in the cluster (for one-off operations)
	 */
	async execute<T>(
		taskFunction: (opts: { page: Page; data: any }) => Promise<T>,
		data?: any
	): Promise<T> {
		const cluster = await this.getCluster();
		return cluster.execute(data, taskFunction);
	}

	/**
	 * Queue a task in the cluster
	 */
	async queue(taskFunction: (opts: { page: Page; data: any }) => Promise<void>, data?: any): Promise<void> {
		const cluster = await this.getCluster();
		cluster.queue(data, taskFunction);
	}

	/**
	 * Check if a session is valid
	 */
	isSessionValid(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) return false;

		// Check if page is still open
		if (session.page.isClosed()) return false;

		return true;
	}

	/**
	 * Get pool statistics
	 */
	getStats() {
		return {
			clusterActive: this.cluster !== null,
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
	 * Wait for all queued tasks to complete
	 */
	async idle(): Promise<void> {
		if (this.cluster) {
			await this.cluster.idle();
		}
	}

	/**
	 * Clean up all resources
	 */
	async cleanup(): Promise<void> {
		debug.log('preview', '🧹 Cleaning up browser pool...');

		// Destroy all sessions
		const sessionIds = Array.from(this.sessions.keys());
		await Promise.all(sessionIds.map((id) => this.destroySession(id)));

		// Close the cluster
		if (this.cluster) {
			try {
				await this.cluster.idle();
				await this.cluster.close();
			} catch (error) {
				debug.warn('preview', `⚠️ Error closing cluster: ${error}`);
			}
			this.cluster = null;
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
