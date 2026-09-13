/**
 * Turn ingestion — the Memory Graph's write path.
 *
 * Called once per turn, after the snapshot has been captured. Two things happen,
 * in this order: the memories standing on code that just changed are aged, and
 * the turn is queued to be summarised into new ones. Ageing goes first so a
 * memory written by THIS turn is not immediately decayed by the same turn's
 * changes — it was written in full knowledge of them.
 *
 * This used to begin by parsing every changed file into nodes for the graph.
 * Migration 076 removed that half: the agent can read the repository, and those
 * nodes never reached a prompt. What a memory is about is now a list of paths on
 * the memory itself, recorded by episodic extraction.
 *
 * Writes are automatic rather than left to the agent's initiative. A graph that
 * only fills when a model remembers to call a `remember` tool stays empty — the
 * agent has no reason to believe anything is worth storing while it is busy
 * solving the immediate problem. The `remember` action exists for deliberate,
 * user-directed memories; this is what makes the graph accumulate on its own.
 */

import { debug } from '$shared/utils/logger';
import { getMemoryConfig } from '../config';
import { takeInjectedMemories } from '../context';
import { invalidateForChanges } from '../invalidate';
import { scheduleEpisodicIngest } from './scheduler';

export { ingestEpisodicMemories } from './episodic';
export {
	deferEpisodicIngest,
	cancel as cancelEpisodicIngest,
	flushEpisodicIngest,
	hasPendingExtraction,
	startExtractionRunner,
	stopExtractionRunner,
	runningExtractions
} from './scheduler';

export interface TurnIngestInput {
	projectId: string;
	projectPath: string;
	sessionId: string;
	userMessageId: string;
	/**
	 * Repo-relative paths that changed on disk DURING THIS TURN.
	 *
	 * A delta, not the session's cumulative change set. The caller computes it by
	 * differencing the snapshot against its parent — see `stream-manager.ts`. The
	 * distinction is load-bearing: `session_changes` grows monotonically for the
	 * life of a session, so passing it directly meant the file cap kept re-ingesting
	 * whatever came first alphabetically while genuinely new files were dropped, and
	 * the extraction prompt described a hundred files as "changed this turn".
	 */
	changedPaths: string[];
	/** Paths that no longer exist on disk. */
	deletedPaths?: string[];
}

/**
 * Ingest one completed turn: age what the change contradicts, queue the summary.
 *
 * Fire-and-forget from the caller's perspective and guaranteed not to throw —
 * the turn is already over, so nothing here may surface as a user-visible
 * failure.
 */
export function ingestTurn(input: TurnIngestInput): void {
	const config = getMemoryConfig();
	if (!config.enabled) return;

	// The code just moved. Memories that described how it worked are now standing
	// on something that changed, and the ones that explain WHY it changed are not
	// — see `invalidate.ts` for why one rate would be worse than doing nothing.
	//
	// Runs whether or not new memories are being recorded: ageing what is already
	// stored is not the same job as writing more of it, and a user who turned
	// recording off still wants what they have to stay honest.
	invalidateForChanges({
		changedPaths: input.changedPaths,
		deletedPaths: input.deletedPaths
	});

	if (!config.recordMemories) return;

	try {
		// Queued rather than awaited, and it runs immediately: the queue is durable,
		// so a crash between here and the model call costs nothing, and the entry
		// carries everything the extraction needs. It is only held back while the
		// session is actually streaming — see `extract/scheduler.ts`.
		scheduleEpisodicIngest({
			projectId: input.projectId,
			projectPath: input.projectPath,
			sessionId: input.sessionId,
			userMessageId: input.userMessageId,
			changedPaths: input.changedPaths,
			deletedPaths: input.deletedPaths,
			// Consumed here rather than read: the memories injected into this turn are
			// adjudicated exactly once, by the extraction that reads the turn they
			// were given to.
			injectedMemoryIds: takeInjectedMemories(input.sessionId)
		});
	} catch (error) {
		debug.warn('memory', 'Turn ingestion failed (non-fatal)', error);
	}
}
