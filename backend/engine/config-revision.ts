/**
 * Engine config revision — the signal that replaced the "Restart Server" button.
 *
 * Open Code is the only engine that runs as a persistent process, and that
 * process freezes its MCP set, provider list and agent registry at spawn. Every
 * other engine reads its config per turn and needs nothing from this module.
 * Until now the gap was covered by asking the user to press a button, which
 * meant the software only worked correctly for people who knew that a button
 * existed and why.
 *
 * Two pieces live here:
 *
 * 1. `getEngineConfigRevision()` — reads the counter that migration 068's
 *    triggers maintain. Everything downstream keys its memoization on this, so
 *    correctness never depends on anyone NOTICING a change; a stale cache is
 *    impossible because the cache key came from the database.
 *
 * 2. `startEngineConfigWatcher()` — polls the counter so a change can also be
 *    ACTED on: warm a replacement server, tell open clients to refetch models.
 *    Polling looks unfashionable next to an event bus, but the alternatives are
 *    worse here. SQLite triggers cannot call into JS, and hooking the WS
 *    dispatch would only catch writes that arrive over WS — missing seeders,
 *    migrations, OAuth token refreshes and any future background writer. The
 *    query is a single-row read of a two-column table against an in-process
 *    SQLite handle; at one per second it is far below the noise floor of
 *    everything else this server does, and it cannot be defeated by a write path
 *    that forgot to announce itself.
 */

import { getDatabase } from '../database';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

/** How often the counter is checked. Only affects reaction latency, never correctness. */
const POLL_MS = 1000;

/**
 * Quiet period before a change is acted on.
 *
 * Settings edits arrive in bursts — a user toggling four connectors and adding a
 * provider produces five bumps in as many seconds. Acting on each would spawn
 * and discard four servers to arrive at the same place. Waiting for the burst to
 * settle produces one.
 */
const SETTLE_MS = 1500;

type ConfigChangeListener = (revision: number) => void;

const listeners = new Set<ConfigChangeListener>();
let watcherTimer: ReturnType<typeof setInterval> | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeenRevision: number | null = null;

/**
 * The current revision, or 0 if the counter is unavailable.
 *
 * Returning 0 rather than throwing is deliberate: callers use this as a cache
 * key, and a database that cannot answer must degrade into "rebuild the config"
 * rather than into "fail the user's turn". A constant 0 makes every subsequent
 * lookup miss, which is slow and correct.
 */
export function getEngineConfigRevision(): number {
	try {
		const row = getDatabase()
			.prepare('SELECT revision FROM engine_config_revision WHERE id = 1')
			.get() as { revision: number } | undefined;
		return row?.revision ?? 0;
	} catch (error) {
		debug.warn('engine', 'Could not read engine config revision; treating config as changed', error);
		return 0;
	}
}

/**
 * Be told when engine-affecting config has settled after a change.
 *
 * Listeners run on the trailing edge of a burst, never per write. A listener
 * that throws is logged and skipped — this is housekeeping, and one subscriber
 * failing must not stop the others from reacting.
 */
export function onEngineConfigChanged(listener: ConfigChangeListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function fire(revision: number): void {
	for (const listener of listeners) {
		try {
			listener(revision);
		} catch (error) {
			debug.warn('engine', 'Engine config listener failed', error);
		}
	}

	// Tell open clients their view of engine config is stale. The payload is a
	// doorbell, not a delivery — the model list is refetched over the existing
	// `models:list` route rather than duplicated into this event. This is what
	// used to happen as a side effect of the restart button's success path.
	try {
		ws.emit.global('engine:config-changed', { revision });
	} catch (error) {
		debug.warn('engine', 'Failed to broadcast engine:config-changed', error);
	}
}

/**
 * Start watching the counter. Idempotent — calling twice does not double-poll.
 *
 * The first observation only records a baseline: at startup the revision is
 * whatever the last session left behind, and treating that as a change would
 * spawn a replacement server for config nobody just edited.
 */
export function startEngineConfigWatcher(): void {
	if (watcherTimer) return;

	lastSeenRevision = getEngineConfigRevision();

	watcherTimer = setInterval(() => {
		const current = getEngineConfigRevision();
		if (current === lastSeenRevision) return;
		lastSeenRevision = current;

		// Restart the settle window on every bump so a burst produces one event
		// on its trailing edge.
		if (settleTimer) clearTimeout(settleTimer);
		settleTimer = setTimeout(() => {
			settleTimer = null;
			debug.log('engine', `Engine config settled at revision ${current}`);
			fire(current);
		}, SETTLE_MS);
		settleTimer.unref?.();
	}, POLL_MS);
	// Housekeeping must never be the reason the process refuses to exit.
	watcherTimer.unref?.();

	debug.log('engine', `Engine config watcher started (revision ${lastSeenRevision})`);
}

/** Stop watching. Used by tests and shutdown. */
export function stopEngineConfigWatcher(): void {
	if (watcherTimer) {
		clearInterval(watcherTimer);
		watcherTimer = null;
	}
	if (settleTimer) {
		clearTimeout(settleTimer);
		settleTimer = null;
	}
	lastSeenRevision = null;
}
