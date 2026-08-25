/**
 * Retention — the bound on how large the graph may grow.
 *
 * The store has no natural bound. Every turn writes structural nodes for the
 * files it touched and episodic nodes for what it concluded, and without this
 * nothing would ever remove either, so the graph would grow linearly with the
 * number of turns the instance had ever served. That is fine for a week and
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

/**
 * How long an unreferenced symbol or module node survives without being touched.
 *
 * Longer than the episodic window on purpose, because a structural node costs
 * far less to be wrong about: re-observing a file re-creates its symbols on the
 * next turn that touches it, at microseconds and with no model involved. What is
 * being bounded here is not error, it is COUNT.
 */
const PRUNE_STRUCTURAL_AFTER_DAYS = 120;

/** Work done per pass, so maintenance never becomes a long stall. */
const BATCH = 200;

/** Structural rows removed per pass — a bigger batch, because it is a plain delete. */
const STRUCTURAL_BATCH = 1_000;

/** Queue entries that outlived any chance of being summarised usefully. */
const QUEUE_MAX_AGE_DAYS = 14;

export interface RetentionResult {
	evicted: number;
	purged: number;
	/** Symbol/module nodes no memory referred to, removed to bound growth. */
	structural: number;
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
	const result: RetentionResult = { evicted: 0, purged: 0, structural: 0, queue: 0 };

	try {
		const candidates = graphQueries.evictionCandidates({
			maxAgeDays: EVICT_AFTER_DAYS,
			maxConfidence: EVICT_BELOW_CONFIDENCE,
			limit: BATCH
		});

		result.evicted = graphQueries.archiveNodes(candidates.map(node => node.id));
		result.purged = graphQueries.purgeArchived(PURGE_ARCHIVED_AFTER_DAYS, BATCH);

		// The structural half is what actually grows without bound. Every turn
		// writes a node per changed file, per directory and up to twenty-five per
		// file's symbols, so on a repository under development it outgrows the
		// episodic half by an order of magnitude — and none of the queries above
		// look at `kind = 'structural'` at all. What is removed here is narrow by
		// construction: symbols and modules that nothing is `about`, untouched for
		// four months. A node any memory hangs off is never eligible, because
		// severing that edge would break the join both halves exist for.
		//
		// The vector cache is deliberately NOT reset here. Structural nodes are never
		// vector-indexed, and even a stale entry left by an older build can only
		// occupy a slot — candidates come from SQL, so nothing the cache no longer
		// has a row for is ever asked about. Reloading a quarter of a million vectors
		// on every retention tick to tidy that would be the expensive half of a
		// problem that does not exist.
		result.structural = graphQueries.pruneStructural({
			maxAgeDays: PRUNE_STRUCTURAL_AFTER_DAYS,
			limit: STRUCTURAL_BATCH
		});
		if (result.evicted > 0 || result.purged > 0 || result.structural > 0) {
			notifyGraphChanged('retention');
			debug.log(
				'memory',
				`Retention: archived ${result.evicted}, removed ${result.purged} archived and ` +
					`${result.structural} unreferenced code node(s)`
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
