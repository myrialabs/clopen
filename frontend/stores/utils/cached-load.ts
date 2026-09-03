/**
 * The load-once cache policy, in one place.
 *
 * Every engine store (accounts, presets, providers) wants the same thing: fetch
 * the list the first time somebody asks, serve it from memory afterwards, and
 * re-fetch on demand. Twelve of them hand-rolled it, and every one of them got
 * the failure case wrong in the same way:
 *
 *     } catch {
 *         accounts = [];
 *         loaded = true;   // ← a FAILED load, cached as a successful empty one
 *     }
 *
 * Because `fetch()` short-circuits on `loaded`, one failed request poisoned the
 * store for the rest of the session: nothing ever retried, and the only way back
 * was a code path that happened to call `refresh()` instead. That is exactly the
 * bug where the chat input reported "no accounts" until Settings → Engines was
 * opened — Settings forces a refresh, so it looked like a fix when it was really
 * just the one caller that bypassed the poisoned cache.
 *
 * And the failure was not rare. A request only has to be slow enough to hit its
 * timeout, which on a busy instance is precisely when several panels ask at once.
 *
 * So the policy lives here instead, and it is one sentence: **only a successful
 * load is cached.** A failure leaves the cache open, keeps whatever good value
 * was already there, and lets the next caller try again.
 *
 * This module is deliberately free of runes so the policy can be tested directly;
 * `cached-load.svelte.ts` wraps it with the reactive `loaded` flag components
 * read. Same split, and same reason, as the panel-load counters in
 * `stores/ui/project-workspace.svelte.ts`.
 */

import { debug } from '$shared/utils/logger';

export interface CachedLoad {
	/** Whether a load has SUCCEEDED and its value is cached. */
	readonly loaded: boolean;
	/**
	 * Load unless a good value is already cached.
	 *
	 * `load` should write the store's own state; this helper only owns whether
	 * that write is allowed to count as cached.
	 */
	ensure(load: () => Promise<void>): Promise<void>;
	/** Load unconditionally, bypassing the cache. */
	refresh(load: () => Promise<void>): Promise<void>;
	/** Mark the cache good without a round trip (the value was set directly). */
	markLoaded(): void;
	/** Drop the cache so the next `ensure()` loads again. */
	reset(): void;
}

/**
 * @param label Used only in the log line when a load fails.
 * @param publish Called whenever `loaded` changes, so a caller can mirror it into
 *   reactive state. Optional — the returned object always reports `loaded`
 *   correctly on its own.
 */
export function createCachedLoadCore(
	label: string,
	publish?: (loaded: boolean) => void
): CachedLoad {
	let loaded = false;
	let inFlight: Promise<void> | null = null;

	function setLoaded(next: boolean): void {
		if (loaded === next) return;
		loaded = next;
		publish?.(next);
	}

	async function run(load: () => Promise<void>): Promise<void> {
		try {
			await load();
			// The ONLY place this becomes true. A load that threw did not produce a
			// value, so there is nothing to cache and nothing to serve.
			setLoaded(true);
		} catch (error) {
			debug.warn('settings', `${label}: load failed, leaving the cache open to retry`, error);
		}
	}

	async function start(load: () => Promise<void>): Promise<void> {
		const pending = run(load);
		inFlight = pending;
		try {
			await pending;
		} finally {
			// Only clear the slot if it is still ours: a `refresh()` may have
			// started a newer load while this one was settling.
			if (inFlight === pending) inFlight = null;
		}
	}

	return {
		get loaded() {
			return loaded;
		},

		async ensure(load: () => Promise<void>): Promise<void> {
			if (loaded) return;
			// Join the request already in flight rather than starting a second one.
			// Several panels mounting together used to fire the same fetch several
			// times over — most visible during a reconnect, where it multiplied the
			// load on a server that was already struggling.
			if (inFlight) return inFlight;
			return start(load);
		},

		async refresh(load: () => Promise<void>): Promise<void> {
			// Deliberately NOT joined to `inFlight`: a caller that asked for a
			// refresh usually just changed something (added an account, revoked a
			// key), and an in-flight read started before that change would answer
			// with the state they are trying to move away from.
			return start(load);
		},

		markLoaded(): void {
			setLoaded(true);
		},

		reset(): void {
			setLoaded(false);
			inFlight = null;
		}
	};
}
