/**
 * Structural invalidation — letting the code tell memory when it has gone out of
 * date.
 *
 * This is the thing the single-store design was for, and until now it was the
 * one part of the argument that was not cashed in. Episodic and structural
 * memory live in one graph joined by `about` edges, which means the write path
 * already knows, for every file that changed on disk this turn, exactly which
 * memories claimed something about it. Nothing else in this space can do that:
 * a conversation-memory product has no view of the codebase, and a code-graph
 * product keeps its conversation facts somewhere else.
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

import { graphQueries } from '$backend/database/queries/graph-queries';
import { debug } from '$shared/utils/logger';

/**
 * Confidence multiplier per subkind when the code a memory is `about` changes.
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
	projectId: string;
	/** Repo-relative paths that changed on disk this turn. */
	changedPaths: string[];
	/** Paths that no longer exist — the file was deleted or renamed away. */
	deletedPaths?: string[];
}

export interface InvalidationResult {
	/** Memories whose confidence was reduced. */
	decayed: number;
	/** Structural nodes retired because their file is gone. */
	archived: number;
}

/**
 * Age the memories attached to code that just changed.
 *
 * Runs on the write path immediately after structural extraction, so the file
 * nodes it looks up are the ones that pass has just upserted. Deliberately
 * OUTSIDE that pass's transaction: structural ingest holds a write transaction
 * across several thousand statements, and extending it over an unrelated read
 * would widen the window in which nothing else can write for no benefit —
 * decaying a memory is idempotent within the cool-off window, so it does not
 * need to roll back with the ingest.
 *
 * Never throws: a memory left slightly over-confident is a far smaller problem
 * than a failed turn-completion hook.
 */
export function invalidateForChanges(input: InvalidationInput): InvalidationResult {
	const result: InvalidationResult = { decayed: 0, archived: 0 };

	try {
		// A deleted file's structural nodes are retired outright. Keeping them would
		// mean BM25 continues to offer paths that no longer exist, which sends an
		// agent to read a file that is gone — a specific, repeatable waste of a turn.
		const deleted = [...new Set(input.deletedPaths ?? [])].slice(0, MAX_FILES);
		if (deleted.length > 0) {
			result.archived = graphQueries.archiveMissingFiles(input.projectId, deleted);
		}

		const changed = input.changedPaths.slice(0, MAX_FILES);
		if (changed.length === 0) return result;

		const fileNodes = graphQueries.getByPaths(input.projectId, changed);
		if (fileNodes.length === 0) return result;

		// Only ONE hop, and only `about` edges. Two hops would reach the memories
		// attached to every file this one imports, and editing a file is not
		// evidence about its dependencies. Resolved in one query rather than by
		// walking every edge of every changed file — on a sixty-file turn most of
		// those edges are `defines` and `imports`, which invalidation has no
		// interest in and would still have to load.
		const affected = graphQueries.memoriesAbout(fileNodes.map(node => node.id));

		if (affected.length === 0) return result;
		result.decayed = graphQueries.markStale(affected, DECAY_BY_SUBKIND);

		if (result.decayed > 0 || result.archived > 0) {
			debug.log(
				'memory',
				`Structural invalidation: ${result.decayed} memory/memories aged, ${result.archived} node(s) retired`
			);
		}
	} catch (error) {
		debug.warn('memory', 'Structural invalidation failed (non-fatal)', error);
	}

	return result;
}
