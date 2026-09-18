/**
 * Browser Pool Module
 *
 * Uses puppeteer-extra with StealthPlugin for Cloudflare bypass.
 * - One Chrome per workspace, launched against a profile directory on disk
 * - Every tab is a page in that profile's default context, in its own window
 * - StealthPlugin applied at launch time (via puppeteer-extra hooks)
 *
 * **Why a profile per workspace rather than a context per tab.**
 * A `BrowserContext` is always incognito: it cannot be written to disk, and it
 * dies with the process. Tabs in one therefore could not stay signed in — not
 * across a restart, and (when each tab had a context of its own) not even
 * across each other. A profile directory is what a real browser uses, and it
 * gives both: tabs of one workspace share cookies, storage and cache, and all
 * of it survives Clopen being stopped. Workspaces still share nothing, because
 * the profile is keyed by the workspace scope.
 *
 * **Why every page gets its own window.**
 * Tabs in one window are mutually exclusive: Chrome marks all but the
 * foreground one `document.visibilityState === 'hidden'`, and a hidden tab
 * cannot be captured — `getDisplayMedia` rejects outright with
 * `InvalidStateError`, and the fallback path composites against the window
 * instead of the tab's emulated viewport, which reaches the viewer as a
 * letterboxed preview. Creating each page with `newWindow: true` keeps every
 * tab visible and capturable at its own device size while still sharing the
 * profile.
 *
 * Why not puppeteer-cluster?
 * - Cluster's CONCURRENCY_CONTEXT mode accesses the browser via the raw
 *   underlying reference, bypassing puppeteer-extra's page creation hooks.
 * - This causes a race condition where stealth evasions (evaluateOnNewDocument)
 *   may not be registered before the first navigation, breaking Cloudflare bypass.
 * - Direct launch() ensures puppeteer-extra wraps ALL page creation correctly.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type { Browser, BrowserContext, CDPSession, Page, Protocol } from 'puppeteer';
import { debug } from '$shared/utils/logger';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getChromeExecutablePath } from '$backend/engine/install-recipes';
import { getClopenDir } from '$backend/utils/paths';
import { scopeSlug } from '$shared/utils/workspace-scope';
import { open as openSealed, seal } from '$backend/database/crypto/envelope';

puppeteer.use(StealthPlugin());

export interface PoolConfig {
	maxConcurrency: number;
	timeout: number;
	retryLimit: number;
	retryDelay: number;
}

export interface PooledSession {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	createdAt: number;
	sessionId: string;
	/** The workspace profile this session's page lives in. */
	profileKey: string;
}

/** One workspace's Chrome, and the sessions living in it. */
interface ProfileBrowser {
	key: string;
	browser: Browser;
	/** Browser-level CDP session — window creation, cookies, storage. */
	cdp: CDPSession;
	sessions: Set<string>;
	idleTimer: ReturnType<typeof setTimeout> | null;
	cookieTimer: ReturnType<typeof setInterval> | null;
	/** Serializes page creation, so two tabs cannot claim each other's window. */
	openLock: Promise<unknown>;
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
		//
		// Kept browser-wide on purpose: Chrome cannot tell the tab we are
		// streaming from the ones nobody is watching, because in headless they
		// look identical to it. Which pages may run is decided explicitly
		// instead, per tab, in `browser-tab-lifecycle.ts` — these flags only
		// stop Chrome from second-guessing that decision.
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

/**
 * How long a workspace's Chrome stays up with no sessions left.
 *
 * Long enough that closing a tab and opening another does not pay for a
 * relaunch, short enough that a machine is not left running headless Chromes
 * nobody is using. Nothing is lost when it goes: the profile is on disk.
 */
const IDLE_BROWSER_CLOSE_MS = 60_000;

/** How often a live browser's session cookies are written to disk. */
const COOKIE_FLUSH_INTERVAL_MS = 60_000;

/**
 * Where a workspace's Chrome profile lives.
 *
 * Hashed rather than slugged alone: `scopeSlug` truncates, and two workspaces
 * that collided would share a login.
 */
function profilesRoot(): string {
	return join(getClopenDir(), 'preview', 'profiles');
}

function profileDirName(profileKey: string): string {
	const digest = createHash('sha256').update(profileKey).digest('hex').slice(0, 16);
	return `${scopeSlug(profileKey) || 'ws'}-${digest}`;
}

function profileDir(profileKey: string): string {
	return join(profilesRoot(), profileDirName(profileKey));
}

/**
 * Session cookies, kept beside the profile.
 *
 * Chrome drops these when it exits — that is what "session" means, and it is
 * why a profile alone does not keep you signed into an app that issues one
 * (which most dev servers do). Carrying them across a restart is the whole
 * point of the persistent preview, so they are saved and put back by hand.
 * Sealed, because a session cookie is a credential.
 */
function cookieFile(profileKey: string): string {
	return join(profilesRoot(), `${profileDirName(profileKey)}.cookies`);
}

class BrowserPool {
	private browsers = new Map<string, ProfileBrowser>();
	private sessions = new Map<string, PooledSession>();
	private launches = new Map<string, Promise<ProfileBrowser>>();
	private config: PoolConfig;

	constructor(config: Partial<PoolConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Get or launch the Chrome that owns a workspace's profile.
	 */
	async getBrowserFor(profileKey: string): Promise<Browser> {
		return (await this.acquireBrowser(profileKey)).browser;
	}

	private async acquireBrowser(profileKey: string): Promise<ProfileBrowser> {
		const existing = this.browsers.get(profileKey);
		if (existing?.browser.connected) {
			this.cancelIdleClose(existing);
			return existing;
		}

		const inFlight = this.launches.get(profileKey);
		if (inFlight) return inFlight;

		const launch = this.launchProfile(profileKey).finally(() => {
			this.launches.delete(profileKey);
		});
		this.launches.set(profileKey, launch);
		return launch;
	}

	private async launchProfile(profileKey: string): Promise<ProfileBrowser> {
		debug.log('preview', `🚀 Launching Chrome for workspace profile ${profileKey}...`);

		// Use the clopen-managed Chrome for Testing under ~/.clopen/bin
		// (macOS/Windows) or the system Google Chrome / chromium installed
		// via the distro package manager (Linux).
		const executablePath = getChromeExecutablePath();
		if (!executablePath) {
			throw new Error('Chrome not installed. Go to Settings → Stack and click Install.');
		}

		const userDataDir = profileDir(profileKey);
		mkdirSync(userDataDir, { recursive: true });
		debug.log('preview', `  using Chrome at: ${executablePath}`);
		debug.log('preview', `  profile: ${userDataDir}`);

		const browser = (await puppeteer.launch({
			headless: true,
			executablePath,
			userDataDir,
			args: CHROME_ARGS
		})) as unknown as Browser;

		const entry: ProfileBrowser = {
			key: profileKey,
			browser,
			cdp: await browser.target().createCDPSession(),
			sessions: new Set(),
			idleTimer: null,
			cookieTimer: null,
			openLock: Promise.resolve()
		};

		browser.on('disconnected', () => {
			debug.warn('preview', `⚠️ Chrome for ${profileKey} disconnected`);
			this.forgetBrowser(entry);
		});

		// Chrome opens a page of its own at launch. Every tab we care about is
		// created in a window of its own, so this one is only a spare renderer
		// and a target the popup watcher would have to reason about.
		for (const page of await browser.pages()) {
			await page.close().catch(() => {});
		}

		this.browsers.set(profileKey, entry);
		await this.restoreSessionCookies(entry);

		entry.cookieTimer = setInterval(() => {
			void this.saveSessionCookies(entry);
		}, COOKIE_FLUSH_INTERVAL_MS);
		// Flushing cookies is never a reason to hold the process open.
		entry.cookieTimer.unref?.();

		debug.log('preview', `✅ Chrome ready for ${profileKey}`);
		return entry;
	}

	/**
	 * Create a session: one page, in its own window, in the workspace profile.
	 *
	 * `profileKey` is the workspace scope. Sessions under different keys share
	 * nothing; sessions under the same key share cookies, storage and cache,
	 * exactly as two tabs of one browser would.
	 */
	async createSession(sessionId: string, profileKey?: string): Promise<PooledSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			debug.log('preview', `♻️ Reusing existing session: ${sessionId}`);
			return existing;
		}

		const key = profileKey || sessionId;
		debug.log('preview', `🔒 Creating session: ${sessionId} (profile: ${key})`);

		const entry = await this.acquireBrowser(key);
		const page = await this.openWindowPage(entry);

		const session: PooledSession = {
			browser: entry.browser,
			context: page.browserContext(),
			page,
			createdAt: Date.now(),
			sessionId,
			profileKey: key
		};

		this.sessions.set(sessionId, session);
		entry.sessions.add(sessionId);
		this.cancelIdleClose(entry);

		debug.log(
			'preview',
			`✅ Session created: ${sessionId} (total: ${this.sessions.size}, profiles: ${this.browsers.size})`
		);

		return session;
	}

	/**
	 * Open a page in a window of its own.
	 *
	 * `newWindow` is only reachable over CDP — `newPage()` always opens a tab
	 * in the existing window, where Chrome would mark it hidden and refuse to
	 * capture it. Serialized per browser: the new target is recognised by
	 * diffing the browser's target list, and two creations in flight at once
	 * could hand each other's page back.
	 */
	private openWindowPage(entry: ProfileBrowser): Promise<Page> {
		const run = async (): Promise<Page> => {
			const before = new Set(entry.browser.targets());

			await entry.cdp.send('Target.createTarget', {
				url: 'about:blank',
				newWindow: true
			} as Protocol.Target.CreateTargetRequest);

			const target = await entry.browser.waitForTarget(
				(candidate) => candidate.type() === 'page' && !before.has(candidate),
				{ timeout: 30_000 }
			);

			const page = await target.page();
			if (!page) throw new Error('Chrome opened a window with no page in it');
			return page;
		};

		const queued = entry.openLock.then(run, run);
		// Swallowed on the lock only: the caller still sees the rejection.
		entry.openLock = queued.catch(() => {});
		return queued;
	}

	/**
	 * Give a session a fresh page in the same profile.
	 *
	 * A crashed renderer takes the page but leaves the profile — and with it
	 * the cookies and storage the tab has built up — so only the page is
	 * replaced.
	 */
	async renewSessionPage(sessionId: string, profileKey?: string): Promise<PooledSession> {
		const existing = this.sessions.get(sessionId);
		const key = profileKey || existing?.profileKey || sessionId;

		if (existing) {
			const entry = this.browsers.get(key);
			if (entry?.browser.connected) {
				try {
					const page = await this.openWindowPage(entry);
					if (!existing.page.isClosed()) {
						await existing.page.close().catch(() => {});
					}
					existing.page = page;
					existing.browser = entry.browser;
					existing.context = page.browserContext();
					debug.log('preview', `♻️ Session ${sessionId}: new window in the surviving profile`);
					return existing;
				} catch (error) {
					debug.warn('preview', `⚠️ Profile ${key} could not hand out a page: ${error}`);
				}
			}
		}

		await this.destroySession(sessionId);
		return this.createSession(sessionId, key);
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
		} catch (error) {
			debug.warn('preview', `⚠️ Error destroying session: ${error}`);
		}

		this.sessions.delete(sessionId);

		// The profile is deliberately untouched. Closing the last tab of a
		// workspace used to take its cookies with it, so opening the same URL
		// again asked for a fresh login — the browser equivalent of losing your
		// session because you closed a tab.
		const entry = this.browsers.get(session.profileKey);
		if (entry) {
			entry.sessions.delete(sessionId);
			if (entry.sessions.size === 0) this.scheduleIdleClose(entry);
		}

		debug.log('preview', `✅ Session destroyed (remaining: ${this.sessions.size})`);
	}

	/**
	 * Close a workspace's Chrome once nothing has referenced it for a while.
	 *
	 * Safe in a way it never used to be: the profile outlives the process, so
	 * the only thing a relaunch costs is the launch itself.
	 */
	private scheduleIdleClose(entry: ProfileBrowser): void {
		this.cancelIdleClose(entry);

		entry.idleTimer = setTimeout(() => {
			entry.idleTimer = null;
			if (entry.sessions.size > 0) return;

			debug.log('preview', `💤 No sessions left for ${entry.key}, closing its Chrome`);
			void this.closeBrowser(entry);
		}, IDLE_BROWSER_CLOSE_MS);

		// Nothing here should hold the process open on its own.
		entry.idleTimer.unref?.();
	}

	private cancelIdleClose(entry: ProfileBrowser): void {
		if (!entry.idleTimer) return;
		clearTimeout(entry.idleTimer);
		entry.idleTimer = null;
	}

	private forgetBrowser(entry: ProfileBrowser): void {
		this.cancelIdleClose(entry);
		if (entry.cookieTimer) {
			clearInterval(entry.cookieTimer);
			entry.cookieTimer = null;
		}
		for (const sessionId of entry.sessions) this.sessions.delete(sessionId);
		entry.sessions.clear();
		if (this.browsers.get(entry.key) === entry) this.browsers.delete(entry.key);
	}

	private async closeBrowser(entry: ProfileBrowser): Promise<void> {
		await this.saveSessionCookies(entry);
		this.forgetBrowser(entry);

		try {
			await entry.browser.close();
		} catch (error) {
			debug.warn('preview', `⚠️ Error closing Chrome for ${entry.key}: ${error}`);
		}
	}

	// ── Session cookies ──────────────────────────────────────────────────────

	private async saveSessionCookies(entry: ProfileBrowser): Promise<void> {
		if (!entry.browser.connected) return;

		try {
			const { cookies } = (await entry.cdp.send(
				'Storage.getCookies'
			)) as Protocol.Storage.GetCookiesResponse;

			// Only the ones Chrome is about to throw away. Persistent cookies
			// are already in the profile, and writing them out again would let
			// a stale copy overwrite a fresher one on the next launch.
			const session = cookies.filter((cookie) => cookie.session);

			mkdirSync(profilesRoot(), { recursive: true });
			const payload = seal(JSON.stringify(session)) ?? '';
			writeFileSync(cookieFile(entry.key), payload, { mode: 0o600 });
		} catch (error) {
			debug.warn('preview', `⚠️ Could not save session cookies for ${entry.key}: ${error}`);
		}
	}

	private async restoreSessionCookies(entry: ProfileBrowser): Promise<void> {
		const path = cookieFile(entry.key);
		if (!existsSync(path)) return;

		try {
			const raw = openSealed(readFileSync(path, 'utf8'));
			if (!raw) return;

			const cookies = JSON.parse(raw) as Protocol.Network.CookieParam[];
			if (!Array.isArray(cookies) || cookies.length === 0) return;

			await entry.cdp.send('Storage.setCookies', { cookies });
			debug.log('preview', `🍪 Restored ${cookies.length} session cookie(s) for ${entry.key}`);
		} catch (error) {
			debug.warn('preview', `⚠️ Could not restore session cookies for ${entry.key}: ${error}`);
		}
	}

	// ── Browsing data ────────────────────────────────────────────────────────

	/**
	 * Sites this workspace has data for, most cookies first.
	 *
	 * Derived from the cookie jar rather than a storage enumeration, which CDP
	 * does not offer: every login leaves a cookie, so this is the list a user
	 * would actually recognise. Origins currently open are folded in by the
	 * caller, which knows the tabs.
	 */
	async listBrowsingOrigins(
		profileKey: string
	): Promise<{ domain: string; cookies: number; secure: boolean }[]> {
		// Launched if it is not up: the profile outlives its Chrome, so "no
		// browser running" is not the same as "nothing stored" — and answering
		// with an empty list would tell the user their logins were already gone.
		const entry = await this.acquireBrowser(profileKey).catch(() => null);
		if (!entry?.browser.connected) return [];

		try {
			const { cookies } = (await entry.cdp.send(
				'Storage.getCookies'
			)) as Protocol.Storage.GetCookiesResponse;

			const byDomain = new Map<string, { cookies: number; secure: boolean }>();
			for (const cookie of cookies) {
				const domain = cookie.domain.replace(/^\./, '');
				const entryFor = byDomain.get(domain) ?? { cookies: 0, secure: false };
				entryFor.cookies += 1;
				// A domain with no open tab has no origin of its own to report,
				// and clearing needs one. A Secure cookie is the only evidence
				// left that the site was https, so it decides the guess.
				entryFor.secure ||= cookie.secure;
				byDomain.set(domain, entryFor);
			}

			return Array.from(byDomain, ([domain, value]) => ({ domain, ...value })).sort(
				(a, b) => b.cookies - a.cookies || a.domain.localeCompare(b.domain)
			);
		} catch (error) {
			debug.warn('preview', `⚠️ Could not list browsing data for ${profileKey}: ${error}`);
			return [];
		} finally {
			// Opened only to be read: let it go again on the usual timer.
			if (entry.sessions.size === 0) this.scheduleIdleClose(entry);
		}
	}

	/**
	 * A page CDP session in this profile, and whether we opened it ourselves.
	 *
	 * `Storage.clearDataForOrigin` is refused on a browser-level session with a
	 * bare "Internal error" — it needs a frame to resolve the storage partition
	 * against. Any page will do, including one on an unrelated origin, so an
	 * open tab is borrowed where there is one and a scratch window opened where
	 * there is not.
	 */
	private async pageSessionFor(entry: ProfileBrowser): Promise<{ cdp: CDPSession; scratch: Page | null }> {
		for (const session of this.sessions.values()) {
			if (session.profileKey !== entry.key) continue;
			if (session.page.isClosed()) continue;
			return { cdp: await session.page.createCDPSession(), scratch: null };
		}

		const scratch = await this.openWindowPage(entry);
		return { cdp: await scratch.createCDPSession(), scratch };
	}

	/**
	 * Forget what a workspace's browser knows — one origin, or all of it.
	 *
	 * Done in place rather than by deleting the profile directory: the tabs
	 * stay open and keep their pages, exactly as clearing data in a real
	 * browser leaves the window you did it from standing.
	 */
	async clearBrowsingData(profileKey: string, origin?: string): Promise<boolean> {
		if (!origin) return this.wipeProfile(profileKey);

		const entry = await this.acquireBrowser(profileKey).catch(() => null);
		if (!entry?.browser.connected) return false;

		const { cdp, scratch } = await this.pageSessionFor(entry);

		try {
			await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
			const cookies = await this.deleteCookiesForHost(entry, cdp, origin);
			await this.dropSavedCookiesFor(entry, origin);
			debug.log(
				'preview',
				`🧹 Cleared browsing data for ${origin} (${profileKey}), ${cookies} cookie(s)`
			);
			return true;
		} catch (error) {
			debug.warn('preview', `⚠️ Could not clear ${origin} for ${profileKey}: ${error}`);
			return false;
		} finally {
			await cdp.detach().catch(() => {});
			if (scratch) await scratch.close().catch(() => {});
			if (entry.sessions.size === 0) this.scheduleIdleClose(entry);
		}
	}

	/**
	 * Empty a workspace's profile completely.
	 *
	 * Done by closing Chrome and deleting the directory rather than by clearing
	 * origin by origin: the storage of a site whose tab was closed weeks ago
	 * cannot be enumerated over CDP, so per-origin clearing would leave exactly
	 * the data the user came here to remove. Open tabs lose their page and are
	 * rebuilt by the recovery path, which is what clearing everything means.
	 */
	private async wipeProfile(profileKey: string): Promise<boolean> {
		const entry = this.browsers.get(profileKey);

		if (entry) {
			// Not closeBrowser(): that flushes the session cookies we are here
			// to destroy, writing them straight back over the wipe.
			this.forgetBrowser(entry);
			await entry.browser.close().catch((error) => {
				debug.warn('preview', `⚠️ Error closing Chrome for ${profileKey}: ${error}`);
			});
		}

		try {
			rmSync(profileDir(profileKey), { recursive: true, force: true });
			rmSync(cookieFile(profileKey), { force: true });
			debug.log('preview', `🧹 Wiped the browsing profile for ${profileKey}`);
			return true;
		} catch (error) {
			debug.warn('preview', `⚠️ Could not wipe the profile for ${profileKey}: ${error}`);
			return false;
		}
	}

	/**
	 * Delete every cookie filed under a site's domain.
	 *
	 * `Storage.clearDataForOrigin` is not enough on its own: it takes out an
	 * origin's host-only cookies and leaves the domain-wide ones (`.site.com`)
	 * standing — which is most of a real login. The visible result was a site
	 * that was genuinely signed out while the panel still counted its cookies,
	 * because the jar the panel reads had barely changed.
	 *
	 * Matched on the domain with its leading dot stripped, which is exactly how
	 * the panel groups cookies into rows: what a row counts is what its Clear
	 * removes, and a cookie shown under another row is left for that row.
	 */
	private async deleteCookiesForHost(
		entry: ProfileBrowser,
		cdp: CDPSession,
		origin: string
	): Promise<number> {
		let host: string;
		try {
			host = new URL(origin).hostname;
		} catch {
			return 0;
		}

		const { cookies } = (await entry.cdp.send(
			'Storage.getCookies'
		)) as Protocol.Storage.GetCookiesResponse;

		const mine = cookies.filter((cookie) => cookie.domain.replace(/^\./, '') === host);

		for (const cookie of mine) {
			await cdp
				.send('Network.deleteCookies', {
					name: cookie.name,
					domain: cookie.domain,
					path: cookie.path
				})
				.catch(() => {});
		}

		return mine.length;
	}

	/** Drop one site's cookies from the saved session snapshot. */
	private async dropSavedCookiesFor(entry: ProfileBrowser, origin: string): Promise<void> {
		const path = cookieFile(entry.key);
		if (!existsSync(path)) return;

		let host: string;
		try {
			host = new URL(origin).hostname;
		} catch {
			return;
		}

		try {
			const raw = openSealed(readFileSync(path, 'utf8'));
			if (!raw) return;

			// Same rule as the live jar, so a cleared site cannot be restored
			// from the snapshot on the next launch.
			const cookies = JSON.parse(raw) as Protocol.Network.CookieParam[];
			const kept = cookies.filter(
				(cookie) => (cookie.domain ?? '').replace(/^\./, '') !== host
			);

			writeFileSync(path, seal(JSON.stringify(kept)) ?? '', { mode: 0o600 });
		} catch {
			// A snapshot we cannot rewrite is one the next launch will overwrite.
		}
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
			browserConnected: Array.from(this.browsers.values()).some((entry) => entry.browser.connected),
			activeProfiles: this.browsers.size,
			activeSessions: this.sessions.size,
			maxConcurrency: this.config.maxConcurrency,
			sessions: Array.from(this.sessions.entries()).map(([id, session]) => ({
				sessionId: id,
				profileKey: session.profileKey,
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

		const entries = Array.from(this.browsers.values());
		await Promise.all(entries.map((entry) => this.closeBrowser(entry)));

		this.sessions.clear();
		this.browsers.clear();

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
