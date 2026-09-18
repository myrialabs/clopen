/**
 * Preview Tab Lifecycle
 *
 * Decides which preview pages are allowed to run. A tab nobody is watching is
 * still a full Chromium renderer: rAF loops, timers, CSS animations, a dev
 * server's HMR socket. Chrome would normally park such a page by itself, but
 * every headless tab looks equally invisible to it — which is why the pool
 * disables background throttling wholesale (see `browser-pool.ts`). That flag
 * buys the streamed tab its full framerate and, until now, bought the other
 * nine the same thing.
 *
 * So the decision is taken here instead, per tab and explicitly:
 *
 * - **active** — someone is watching it, an agent holds it, or it is still
 *   loading. The page runs at full speed, exactly as before.
 * - **frozen** — nobody is watching. `Page.setWebLifecycleState: 'frozen'`
 *   suspends the page's task queues: no timers, no rAF, no script at all,
 *   while the DOM, the scroll position and the last painted frame stay exactly
 *   as they were. Waking is a single CDP round-trip, so switching back to a
 *   tab looks instant and shows what the page actually is — not a reload.
 *
 * Freezing rather than discarding is deliberate: a preview is something you
 * come back to mid-flow (a form half filled in, a modal open, a scroll
 * position), and a discarded page would have to be rebuilt from its URL and
 * would lose all of that.
 *
 * Nothing here ever freezes a tab that has a viewer attached or that an agent
 * is holding — including under the host budget, which only ever reclaims idle
 * tabs. A frozen tab runs no JavaScript, so anything that evaluates in the
 * page must call `ensureAwake()` first.
 */

import { EventEmitter } from 'events';
import type { CDPSession, Page } from 'puppeteer';
import { debug } from '$shared/utils/logger';
import { getHostCaptureProfile } from './capture-profile';

export type TabLifecycleState = 'active' | 'frozen';

export interface TabLifecycleDeps {
	/** The tab's current page, or null if it has none (closed, mid-rebuild). */
	getPage(tabId: string): Page | null;
	/**
	 * Tabs that must keep running even with no viewer: an agent is driving
	 * them, or they are still loading and freezing would strand them half
	 * rendered.
	 */
	isPinned(tabId: string): boolean;
	/**
	 * Grace before an unwatched tab is frozen. Defaults to FREEZE_AFTER_MS;
	 * overridden only where waiting eight real seconds is not an option.
	 */
	freezeAfterMs?: number;
}

/**
 * Grace between the last viewer leaving and the freeze.
 *
 * Long enough that flicking between two tabs never pays for a thaw, short
 * enough that a tab left behind stops costing anything within a few seconds.
 */
const FREEZE_AFTER_MS = 8_000;

/**
 * Ceiling on a single lifecycle round-trip.
 *
 * DevTools commands are served on an inspector task runner that page freezing
 * does not touch, so a thaw always has someone to answer it — but a renderer
 * that is wedged for some other reason must not take the tab's queue down with
 * it, because `ensureAwake()` is awaited on the path of every click.
 */
const LIFECYCLE_TIMEOUT_MS = 5_000;

/**
 * How many times a page may refuse to freeze before we stop asking.
 *
 * The tab keeps working; it just costs what it always did. Retrying for ever
 * would turn one unfreezable page into a CDP call every few seconds for the
 * rest of the session.
 */
const MAX_FREEZE_FAILURES = 3;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} timed out`)), LIFECYCLE_TIMEOUT_MS);
		timer.unref?.();
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			}
		);
	});
}

interface LifecycleEntry {
	tabId: string;
	/** What the page is doing right now. */
	state: TabLifecycleState;
	/** What it has been asked to do; applied asynchronously, newest wins. */
	target: TabLifecycleState;
	/** Viewers currently watching, on screen. A hidden viewer is not one. */
	viewers: Set<string>;
	/** Last moment this tab was watched, driven or touched. */
	lastAwakeAt: number;
	timer: ReturnType<typeof setTimeout> | null;
	cdp: CDPSession | null;
	/** The page the CDP session belongs to — a rebuild invalidates it. */
	cdpPage: Page | null;
	/** Whether this session needed `Page.enable` before it would take commands. */
	pageEnabled: boolean;
	/**
	 * Consecutive failed freezes on this page.
	 *
	 * A page that refuses to freeze — a build without the command, a renderer
	 * that will not answer — must not be asked again every few seconds for the
	 * rest of the session. Reset whenever the page is replaced or successfully
	 * woken, so the next page gets a clean chance.
	 */
	freezeFailures: number;
	/** Why the current target was chosen — reported once it actually lands. */
	reason: string;
	/** Transition queue, so two decisions can never interleave on one tab. */
	work: Promise<unknown>;
}

export class BrowserTabLifecycle extends EventEmitter {
	private entries = new Map<string, LifecycleEntry>();
	private deps: TabLifecycleDeps;
	private readonly freezeAfterMs: number;

	constructor(deps: TabLifecycleDeps) {
		super();
		this.deps = deps;
		this.freezeAfterMs = deps.freezeAfterMs ?? FREEZE_AFTER_MS;
	}

	/** Start managing a tab. New tabs begin awake — they are about to load. */
	register(tabId: string): void {
		if (this.entries.has(tabId)) return;

		this.entries.set(tabId, {
			tabId,
			state: 'active',
			target: 'active',
			viewers: new Set(),
			lastAwakeAt: Date.now(),
			timer: null,
			cdp: null,
			cdpPage: null,
			pageEnabled: false,
			freezeFailures: 0,
			reason: 'new tab',
			work: Promise.resolve()
		});

		this.schedule(tabId);
	}

	/**
	 * The tab's page was replaced (crash recovery). The new page is awake by
	 * definition and the old CDP session is gone with the old target.
	 */
	rebind(tabId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		void this.dropSession(entry);
		entry.state = 'active';
		entry.target = 'active';
		entry.freezeFailures = 0;
		entry.lastAwakeAt = Date.now();
		this.schedule(tabId);
	}

	/** Stop managing a tab and release its CDP session. */
	dispose(tabId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		this.clearTimer(entry);
		void this.dropSession(entry);
		this.entries.delete(tabId);
	}

	/** A viewer started watching this tab. */
	attachViewer(tabId: string, viewerId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		entry.viewers.add(viewerId);
		entry.lastAwakeAt = Date.now();
		this.schedule(tabId);
	}

	/** A viewer stopped watching — closed the panel, switched tab, went away. */
	detachViewer(tabId: string, viewerId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		entry.viewers.delete(viewerId);
		this.schedule(tabId);
	}

	/**
	 * A viewer put the preview off screen (or brought it back).
	 *
	 * Treated as leaving and returning: capture is already suspended in that
	 * state, so there is nothing left for the page to be running for.
	 */
	setViewerVisible(tabId: string, viewerId: string, visible: boolean): void {
		if (visible) this.attachViewer(tabId, viewerId);
		else this.detachViewer(tabId, viewerId);
	}

	/** Every viewer of this tab is gone at once (stream torn down). */
	dropViewers(tabId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		entry.viewers.clear();
		this.schedule(tabId);
	}

	/**
	 * Something happened on this tab. Pushes the freeze back and, if it was
	 * already frozen, starts waking it — without waiting for the wake to land.
	 */
	touch(tabId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		entry.lastAwakeAt = Date.now();
		if (entry.target === 'frozen') {
			void this.ensureAwake(tabId);
			return;
		}
		this.schedule(tabId);
	}

	/**
	 * Wake the tab and wait for it. Required before anything that runs script
	 * in the page — a frozen page would leave the evaluate hanging until it
	 * timed out.
	 */
	async ensureAwake(tabId: string): Promise<void> {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		entry.lastAwakeAt = Date.now();

		if (entry.target !== 'active') {
			entry.target = 'active';
			entry.reason = 'woken on demand';
			this.queue(entry, () => this.applyTarget(entry));
		}

		this.schedule(tabId);
		await entry.work.catch(() => {});
	}

	/** Whether anybody has this tab on screen right now. */
	hasViewers(tabId: string): boolean {
		return (this.entries.get(tabId)?.viewers.size ?? 0) > 0;
	}

	getState(tabId: string): TabLifecycleState {
		return this.entries.get(tabId)?.state ?? 'active';
	}

	isFrozen(tabId: string): boolean {
		return this.getState(tabId) === 'frozen';
	}

	/** Thaw everything and forget it. Used when the whole service goes away. */
	async cleanup(): Promise<void> {
		const entries = Array.from(this.entries.values());
		this.entries.clear();

		await Promise.all(
			entries.map(async (entry) => {
				this.clearTimer(entry);
				await this.dropSession(entry);
			})
		);
	}

	// ── Internals ────────────────────────────────────────────────────────────

	/**
	 * Decide when this tab should next change state.
	 *
	 * A tab with a viewer or an agent on it is woken immediately; anything else
	 * gets a countdown to the freeze, restarted on every call.
	 */
	private schedule(tabId: string): void {
		const entry = this.entries.get(tabId);
		if (!entry) return;

		this.clearTimer(entry);

		if (this.mustStayAwake(entry)) {
			if (entry.target !== 'active') {
				entry.target = 'active';
				entry.reason = 'in use again';
				this.queue(entry, () => this.applyTarget(entry));
			}
			this.enforceBudget(tabId);
			return;
		}

		if (entry.target === 'frozen') return;
		if (entry.freezeFailures >= MAX_FREEZE_FAILURES) return;

		entry.timer = setTimeout(() => {
			entry.timer = null;
			this.freeze(entry, 'idle');
		}, this.freezeAfterMs);

		// A sleeping preview must never be the reason the process stays up.
		entry.timer.unref?.();
	}

	private mustStayAwake(entry: LifecycleEntry): boolean {
		if (entry.viewers.size > 0) return true;
		try {
			return this.deps.isPinned(entry.tabId);
		} catch {
			return false;
		}
	}

	private freeze(entry: LifecycleEntry, reason: string): void {
		if (!this.entries.has(entry.tabId)) return;
		if (this.mustStayAwake(entry)) {
			this.schedule(entry.tabId);
			return;
		}
		if (entry.target === 'frozen') return;

		entry.target = 'frozen';
		entry.reason = reason;
		this.queue(entry, () => this.applyTarget(entry));
	}

	/**
	 * Keep the number of running pages within what this host can carry.
	 *
	 * Only idle tabs are ever reclaimed — a watched or agent-held tab is never
	 * a candidate, whatever the budget says, because freezing one would break
	 * something the user can see. The budget therefore bounds the transient
	 * pile-up (ten tabs restored at once, a batch opened by an agent) rather
	 * than fighting the user's actual attention.
	 */
	private enforceBudget(exemptTabId?: string): void {
		const budget = getHostCaptureProfile().maxAwakeTabs;

		const awake = Array.from(this.entries.values()).filter((entry) => entry.target === 'active');
		let over = awake.length - budget;
		if (over <= 0) return;

		const reclaimable = awake
			.filter((entry) => entry.tabId !== exemptTabId && !this.mustStayAwake(entry))
			.sort((a, b) => a.lastAwakeAt - b.lastAwakeAt);

		for (const entry of reclaimable) {
			if (over <= 0) break;
			this.clearTimer(entry);
			this.freeze(entry, `over budget (${awake.length}/${budget} awake)`);
			over -= 1;
		}
	}

	private clearTimer(entry: LifecycleEntry): void {
		if (!entry.timer) return;
		clearTimeout(entry.timer);
		entry.timer = null;
	}

	private queue(entry: LifecycleEntry, step: () => Promise<void>): void {
		entry.work = entry.work.then(step, step).catch(() => {});
	}

	/**
	 * Bring the page in line with `target`.
	 *
	 * Reads the target at the moment it runs rather than closing over it, so a
	 * wake queued behind a freeze settles on the newest decision instead of
	 * replaying a stale one.
	 */
	private async applyTarget(entry: LifecycleEntry): Promise<void> {
		if (!this.entries.has(entry.tabId)) return;
		if (entry.state === entry.target) return;

		const target = entry.target;
		const page = this.deps.getPage(entry.tabId);

		// No page to freeze or wake: a tab mid-rebuild is awake by definition
		// once its new page arrives, and `rebind()` resets the state then.
		if (!page || page.isClosed()) {
			entry.state = 'active';
			entry.target = 'active';
			return;
		}

		if (entry.cdpPage && entry.cdpPage !== page) {
			await this.dropSession(entry);
		}

		try {
			const cdp = await this.sessionFor(entry, page);
			await this.sendLifecycle(entry, cdp, target);
		} catch (error) {
			// Left in the state it was actually in — a tab we failed to freeze
			// is still running, and claiming otherwise would hide it from the
			// budget and show the user a sleeping badge on a page burning CPU.
			debug.warn('preview', `⚠️ Lifecycle ${target} failed for ${entry.tabId}: ${error}`);
			entry.target = entry.state;

			if (target === 'frozen') {
				entry.freezeFailures += 1;
				if (entry.freezeFailures >= MAX_FREEZE_FAILURES) {
					debug.warn('preview', `⚠️ Giving up on freezing ${entry.tabId}; it will keep running`);
				} else {
					// Try again on the usual countdown rather than never.
					this.schedule(entry.tabId);
				}
			}
			return;
		}

		entry.state = target;
		if (target === 'active') {
			entry.lastAwakeAt = Date.now();
			entry.freezeFailures = 0;
		}

		// Logged here rather than where the decision is taken: a freeze the
		// user cancelled by clicking back into the tab is queued and then
		// dropped, and announcing it up front reported sleeps that never were.
		debug.log(
			'preview',
			`${target === 'frozen' ? '😴 Froze' : '☀️ Woke'} preview tab ${entry.tabId} (${entry.reason})`
		);

		this.emit('state', { tabId: entry.tabId, state: target });
	}

	private async sessionFor(entry: LifecycleEntry, page: Page): Promise<CDPSession> {
		if (entry.cdp && entry.cdpPage === page) return entry.cdp;

		const cdp = await page.createCDPSession();
		entry.cdp = cdp;
		entry.cdpPage = page;
		entry.pageEnabled = false;
		return cdp;
	}

	/**
	 * `Page.setWebLifecycleState` is refused by some builds until the Page
	 * domain is enabled on the session asking for it. Enabling it up front
	 * would subscribe every tab to page events we have no use for (and that
	 * another session already handles), so we only pay for it on the failure
	 * that asks for it.
	 */
	private async sendLifecycle(
		entry: LifecycleEntry,
		cdp: CDPSession,
		state: TabLifecycleState
	): Promise<void> {
		try {
			await withTimeout(cdp.send('Page.setWebLifecycleState', { state }), `lifecycle ${state}`);
			return;
		} catch (error) {
			if (entry.pageEnabled) throw error;
		}

		await withTimeout(cdp.send('Page.enable'), 'Page.enable');
		entry.pageEnabled = true;
		await withTimeout(cdp.send('Page.setWebLifecycleState', { state }), `lifecycle ${state}`);
	}

	private async dropSession(entry: LifecycleEntry): Promise<void> {
		const cdp = entry.cdp;
		entry.cdp = null;
		entry.cdpPage = null;
		entry.pageEnabled = false;
		if (!cdp) return;
		await cdp.detach().catch(() => {});
	}
}
