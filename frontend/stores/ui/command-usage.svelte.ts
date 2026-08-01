/**
 * Command Palette usage tracking (per-user, server-persisted).
 *
 * Records how often and how recently each palette item is activated so the
 * Command Palette can rank frequent/recent entries to the top — the "smart"
 * ordering that makes Quick Search feel intelligent without any engine call.
 *
 * Persisted through `user:save-state` (not localStorage) so the ranking follows
 * the user across devices, same as the rest of their per-user state.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

interface UsageEntry {
	/** Number of times this item has been activated. */
	count: number;
	/** Epoch millis of the most recent activation. */
	lastUsed: number;
}

export const commandUsage = $state<Record<string, UsageEntry>>({});

/** Apply server-restored usage during initialization (from `user:restore-state`). */
export function applyCommandUsage(saved: Record<string, UsageEntry> | null): void {
	if (!saved || typeof saved !== 'object') return;
	for (const [id, entry] of Object.entries(saved)) {
		if (entry && typeof entry.count === 'number') {
			commandUsage[id] = { count: entry.count, lastUsed: entry.lastUsed ?? 0 };
		}
	}
	debug.log('workspace', 'Applied server command usage');
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Persist to the server, debounced — activations come in quick bursts. */
function persist(): void {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		ws.http('user:save-state', { key: 'commandUsage', value: { ...commandUsage } }).catch((err) => {
			debug.error('workspace', 'Failed to save command usage:', err);
		});
	}, 500);
}

/** Record one activation of a palette item, keyed by its stable palette id. */
export function recordCommandUsage(id: string): void {
	const entry = commandUsage[id] ?? { count: 0, lastUsed: 0 };
	commandUsage[id] = { count: entry.count + 1, lastUsed: Date.now() };
	persist();
}

/**
 * Ranking boost for a palette item derived from how often and how recently it
 * was used. Kept small relative to fuzzy match scores so relevance to the typed
 * query always dominates — usage only breaks ties and orders the empty state.
 */
export function usageBoost(id: string): number {
	const entry = commandUsage[id];
	if (!entry) return 0;
	const frequency = Math.min(entry.count, 10); // cap so one command can't dominate
	const ageMs = Date.now() - entry.lastUsed;
	const dayMs = 24 * 60 * 60 * 1000;
	const recency = ageMs < dayMs ? 3 : ageMs < 7 * dayMs ? 1.5 : 0;
	return frequency * 0.5 + recency;
}
