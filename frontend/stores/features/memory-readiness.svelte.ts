/**
 * Whether memory is usable yet, for the setup banner.
 *
 * Deliberately NOT part of `memory-graph.svelte.ts`. That store loads the graph,
 * its stats and its filters, and exists only while the Memory modal is open. The
 * banner is the opposite: it must be live from the moment the app mounts —
 * precisely for the user who has never opened the modal and has no idea memory
 * is waiting on anything.
 *
 * Polling is a fallback, not the mechanism. The server pushes
 * `memory:readiness-changed` on every transition, and the interval only exists
 * to move the "next attempt in 3m" countdown while nothing else is happening.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { MemoryReadiness } from '$shared/types/memory';

let readiness = $state<MemoryReadiness | null>(null);
let installing = $state(false);
let dismissedAt = $state<number | null>(null);

/**
 * How long a dismissal lasts.
 *
 * Dismissal is deliberately temporary. Memory that never recalls is not a
 * cosmetic problem the user can decide to live with — it is the feature not
 * working — so the banner comes back, while still honouring "not right now".
 * Switching memory off in Settings is the permanent answer, and that clears the
 * banner outright because `setupRequired` goes false.
 */
const DISMISS_MS = 60 * 60 * 1000;

/** Only while a countdown is on screen; the push event carries everything else. */
const TICK_MS = 30_000;

export const memoryReadinessStore = {
	get readiness() {
		return readiness;
	},
	get installing() {
		return installing;
	},

	/** True when the banner should be on screen. */
	get showBanner(): boolean {
		if (!readiness?.setupRequired) return false;
		if (dismissedAt === null) return true;
		return Date.now() - dismissedAt > DISMISS_MS;
	},

	async refresh(): Promise<MemoryReadiness | null> {
		try {
			readiness = (await ws.http('memory:readiness', {})) as MemoryReadiness;
		} catch (error) {
			// A banner that cannot read its own status simply stays hidden. Memory is
			// not broken by this; the report of it is.
			debug.error('settings', 'Failed to load memory readiness:', error);
			readiness = null;
		}
		return readiness;
	},

	/**
	 * Ask the server to install the artifact now.
	 *
	 * Resolves only once the attempt has finished, so the button can stay in a
	 * pending state for the whole download rather than flicking back and leaving
	 * the user unsure whether anything happened.
	 */
	async install(): Promise<void> {
		if (installing) return;
		installing = true;
		// Clear any dismissal: the user just asked for this, so they want to see how
		// it goes.
		dismissedAt = null;
		try {
			readiness = (await ws.http('memory:install-embedding', {})) as MemoryReadiness;
		} catch (error) {
			debug.error('settings', 'Failed to install the embedding artifact:', error);
			await this.refresh();
		} finally {
			installing = false;
		}
	},

	dismiss(): void {
		dismissedAt = Date.now();
	},

	/** Live updates plus a slow tick for the retry countdown. Returns teardown. */
	subscribe(): () => void {
		void this.refresh();

		const off = ws.on('memory:readiness-changed', () => {
			void this.refresh();
		});
		const timer = setInterval(() => {
			// Only while something is actually pending — no reason to poll a machine
			// whose memory has been working for hours.
			if (readiness?.setupRequired) void this.refresh();
		}, TICK_MS);

		return () => {
			off();
			clearInterval(timer);
		};
	}
};
