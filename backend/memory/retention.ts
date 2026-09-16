/**
 * Retention — the bound on how large the graph may grow.
 *
 * The store has no natural bound. Every turn writes what it concluded, and
 * without this nothing would ever remove any of it, so the graph would grow
 * linearly with the number of turns the instance had ever served. That is fine for a week and
 * untenable for a year: the vector scan, the FTS index and the graph view all
 * degrade together, and the user's only recourse would be "Clear All Data".
 *
 * Three mechanisms, in the order they should be preferred:
 *
 *   1. **Consolidation** (`consolidate.ts`) — compress rather than delete. Always
 *      the better answer, because nothing is lost.
 *   2. **Eviction** (here) — remove auto-written memories that have provably
 *      earned nothing: never used, never read, low confidence, old.
 *   3. **Purge** (here) — permanently delete auto-written nodes archived long
 *      enough ago that "undo" is no longer a real scenario.
 *
 * Nothing a person touched is ever eligible for any of them. `source = 'user'`,
 * `pinned`, and anything with a `useful_count` are exempt by the queries
 * themselves, not by a check a future edit could forget.
 */

import { graphQueries } from '$backend/database/queries/graph-queries';
import { memoryQueueQueries } from '$backend/database/queries/memory-queue-queries';
import { debug } from '$shared/utils/logger';
import { notifyGraphChanged } from './notify';

/**
 * How old a memory must be before failing every other test counts as evidence.
 *
 * Long, on purpose. A memory written last month that has not been retrieved yet
 * has not failed — it has not been TESTED, because the work it applies to has not
 * come up. Ninety days is roughly the point where "never once relevant" starts to
 * mean something.
 */
const EVICT_AFTER_DAYS = 90;

/** Confidence at or below which an unused memory is a candidate for eviction. */
const EVICT_BELOW_CONFIDENCE = 0.45;

/** How long an archived node is kept so it can still be restored. */
const PURGE_ARCHIVED_AFTER_DAYS = 60;

/** Work done per pass, so maintenance never becomes a long stall. */
const BATCH = 200;

/** Queue entries that outlived any chance of being summarised usefully. */
const QUEUE_MAX_AGE_DAYS = 14;

export interface RetentionResult {
	evicted: number;
	purged: number;
	/** Extraction queue rows dropped as orphaned or stale. */
	queue: number;
}

/**
 * Apply the retention policy once. Never throws.
 *
 * Eviction ARCHIVES rather than deletes, so the second mechanism is the only one
 * that ever destroys a row, and it only sees rows that have already been archived
 * for two months. A memory therefore has to survive two independent decisions,
 * separated by sixty days, before it is actually gone.
 */
export function applyRetention(): RetentionResult {
	const result: RetentionResult = { evicted: 0, purged: 0, queue: 0 };

	try {
		const candidates = graphQueries.evictionCandidates({
			maxAgeDays: EVICT_AFTER_DAYS,
			maxConfidence: EVICT_BELOW_CONFIDENCE,
			limit: BATCH
		});

		result.evicted = graphQueries.archiveNodes(candidates.map(node => node.id));
		result.purged = graphQueries.purgeArchived(PURGE_ARCHIVED_AFTER_DAYS, BATCH);

		// A pass that removed the codebase half used to run here too, and it was by
		// far the largest term: a node per changed file, per directory and up to
		// twenty-five per file's symbols, every turn. Migration 076 removed the half
		// rather than the growth, so what is left to bound is the memories — which
		// grow with what was CONCLUDED rather than with what was touched, and are
		// therefore bounded by the work itself.
		if (result.evicted > 0 || result.purged > 0) {
			notifyGraphChanged('retention');
			debug.log(
				'memory',
				`Retention: archived ${result.evicted}, removed ${result.purged} archived node(s)`
			);
		}
	} catch (error) {
		debug.warn('memory', 'Retention pass failed (non-fatal)', error);
	}

	// Its own try: the queue lives in a different table with a different lifetime,
	// and losing a whole graph-retention pass because a queue query failed would be
	// the wrong trade in the wrong direction.
	try {
		result.queue = memoryQueueQueries.pruneOrphans() + memoryQueueQueries.pruneStale(QUEUE_MAX_AGE_DAYS);
		if (result.queue > 0) {
			debug.log('memory', `Retention: dropped ${result.queue} orphaned/stale extraction entr(ies)`);
		}
	} catch (error) {
		debug.warn('memory', 'Extraction queue retention failed (non-fatal)', error);
	}

	return result;
}
