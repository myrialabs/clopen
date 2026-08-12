/**
 * Turn ingestion — the Memory Graph's write path.
 *
 * Called once per turn, after the snapshot has been captured. Structural
 * extraction runs first and returns its path → node map, which episodic
 * extraction then uses to attach `about` edges: the memory has to be able to
 * name the code it concerns, and the code node must therefore already exist.
 * Between the two, structural invalidation ages the memories whose code just
 * changed underneath them.
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
import { scheduleVectorIndexing } from '../indexer';
import { invalidateForChanges } from '../invalidate';
import { notifyGraphChanged } from '../notify';
import { scheduleEpisodicIngest } from './scheduler';
import { ingestStructuralChanges } from './structural';

export { ingestStructuralChanges } from './structural';
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
	/** Paths that no longer exist on disk, so their nodes can be retired. */
	deletedPaths?: string[];
}

/**
 * Ingest one completed turn: structural nodes now, episodic summary later.
 *
 * Fire-and-forget from the caller's perspective and guaranteed not to throw —
 * the turn is already over, so nothing here may surface as a user-visible
 * failure.
 */
export async function ingestTurn(input: TurnIngestInput): Promise<void> {
	const config = getMemoryConfig();
	if (!config.enabled) return;

	// The structural half is allowed to fail on its own.
	//
	// It reads the disk, and reading the disk can go wrong in ways the episodic
	// half has no stake in — a file that vanished mid-turn, a permission error, a
	// snapshot that never completed. Sharing one `try` meant any of those cost the
	// TRANSCRIPT too, and the transcript is the irreplaceable half: the code can
	// be re-read on the next turn, while the conversation that explained why it
	// changed exists once.
	let fileNodes = new Map<string, string>();
	if (config.recordCode) {
		try {
			const structural = await ingestStructuralChanges({
				projectId: input.projectId,
				projectPath: input.projectPath,
				sessionId: input.sessionId,
				changedPaths: input.changedPaths
			});
			fileNodes = structural.fileNodes;

			// Structural nodes are searchable immediately; ask for their vectors now
			// rather than waiting for episodic extraction to finish talking to a model.
			if (structural.files > 0) {
				scheduleVectorIndexing();
				notifyGraphChanged('code', input.projectId);
			}

			// The code just moved. Memories that described how it worked are now
			// standing on something that changed, and the ones that explain WHY it
			// changed are not — see `invalidate.ts` for why one rate would be worse
			// than doing nothing.
			invalidateForChanges({
				projectId: input.projectId,
				changedPaths: input.changedPaths,
				deletedPaths: input.deletedPaths
			});
		} catch (error) {
			debug.warn('memory', 'Structural ingestion failed (non-fatal)', error);
		}
	}

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
			fileNodes,
			// Consumed here rather than read: the memories injected into this turn are
			// adjudicated exactly once, by the extraction that reads the turn they
			// were given to.
			injectedMemoryIds: takeInjectedMemories(input.sessionId)
		});
	} catch (error) {
		debug.warn('memory', 'Turn ingestion failed (non-fatal)', error);
	}
}
