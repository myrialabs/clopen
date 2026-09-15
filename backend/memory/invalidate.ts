/**
 * Structural invalidation — letting the code tell memory when it has gone out of
 * date.
 *
 * Every memory records the files it claims something about (`graph_node_paths`,
 * migration 076), and the write path already knows which files changed on disk
 * this turn. Intersecting the two is the whole mechanism: a memory standing on
 * code that just moved is a memory to trust slightly less, and nothing else in
 * this space can make that connection — a conversation-memory product has no
 * view of the codebase, and a code-graph product keeps its conversation facts
 * somewhere else.
 *
 * This used to walk from a path to a file NODE to the `about` edges hanging off
 * it. The node in between was 81% of the graph and did nothing else worth
 * keeping, so the lookup is now a single index seek on the path itself.
 *
 * The decay is per subkind, and that distinction is the whole design:
 *
 *   observation — "the stream manager captures the snapshot in its finally
 *                 block". A statement ABOUT the code, invalidated by the code
 *                 changing. Decays hard.
 *   failure     — "restoring a snapshot mid-stream corrupts the tree". Usually
 *                 fixed by the very change that touched the file, so it decays,
 *                 but less: a fixed bug is still worth knowing about.
 *   pattern     — a convention. Survives an individual file being edited, but a
 *                 sustained rewrite is evidence it may no longer hold.
 *   decision    — "we chose SQLite over Postgres because…". The REASON the change
 *                 happened. A rewrite is not evidence against it; frequently it
 *                 is the decision being carried out. Does not decay.
 *   preference  — belongs to the user, not the file. Does not decay.
 *   entity      — belongs to the world. Does not decay.
 *
 * Applying one rate to all six would be strictly worse than doing nothing: it
 * would either leave stale observations at full confidence or quietly destroy
 * the decisions that are the most valuable thing in the store.
 *
 * Nothing is deleted here. Confidence falls and `stale_at` is set, so a memory
 * drops below the injection floor and out of the top of rankings while staying
 * fully readable, restorable and visible in the graph view.
 *
 * And the decay does not COMPOUND: `markStale` refuses to touch a memory it
 * already marked within the last few hours. One code change is one piece of
 * evidence however many times the file is saved, and without that guard an
 * ordinary afternoon of iterating on a single file multiplies every observation
 * about it by 0.82 ten times over — 0.14, well under the injection floor. The
 * mechanism meant to keep stale memories honest would instead have deleted, in
 * effect, everything the graph knew about whatever was being worked on.
 */

import { graphQueries, normalizePath } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';

/**
 * Confidence multiplier per subkind when the code a memory is about changes.
 * A subkind absent from this map, or mapped to 1, is never decayed.
 */
const DECAY_BY_SUBKIND: Record<string, number> = {
	observation: 0.82,
	failure: 0.92,
	pattern: 0.97,
	decision: 1,
	preference: 1,
	entity: 1
};

/** Files examined per turn. Beyond this the turn was a bulk operation. */
const MAX_FILES = 60;

export interface InvalidationInput {
	/** Repo-relative paths that changed on disk this turn. */
	changedPaths: string[];
	/**
	 * Paths that no longer exist — the file was deleted or renamed away.
	 *
	 * Treated as changed rather than as a category of its own. Deletion is the
	 * strongest form of "the code moved underneath this", and the per-subkind
	 * rates already say the right thing about it: an observation describing a file
	 * that is gone should fall, while the decision that removed it should not.
	 *
	 * The attribution itself is left alone. A memory about a file that no longer
	 * exists is still a memory about that file, and severing the link would lose
	 * the only record of what a since-deleted module taught.
	 */
	deletedPaths?: string[];
}

export interface InvalidationResult {
	/** Memories whose confidence was reduced. */
	decayed: number;
}

/**
 * Age the memories attached to code that just changed.
 *
 * Never throws: a memory left slightly over-confident is a far smaller problem
 * than a failed turn-completion hook.
 */
export function invalidateForChanges(input: InvalidationInput): InvalidationResult {
	const result: InvalidationResult = { decayed: 0 };

	try {
		const paths = [
			...new Set([...input.changedPaths, ...(input.deletedPaths ?? [])].map(normalizePath))
		]
			.filter(Boolean)
			.slice(0, MAX_FILES);
		if (paths.length === 0) return result;

		const affected = graphQueries.memoriesForPaths(paths);
		if (affected.length === 0) return result;

		result.decayed = graphQueries.markStale(affected, DECAY_BY_SUBKIND);

		if (result.decayed > 0) {
			debug.log('memory', `Structural invalidation: ${result.decayed} memory/memories aged`);
		}
	} catch (error) {
		debug.warn('memory', 'Structural invalidation failed (non-fatal)', error);
	}

	return result;
}
