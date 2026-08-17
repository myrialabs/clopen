/**
 * Telling open Memory views that the graph moved.
 *
 * Without this the visualization was a snapshot taken at mount: a conversation
 * could write eight memories while the modal sat open in another tab and none of
 * them appeared until the browser was reloaded. For a feature whose whole premise
 * is "this fills up as you work", that is the wrong default.
 *
 * The broadcast is COALESCED, and that is the load-bearing part. A single turn's
 * ingestion writes a file node, a module node, a `contains` edge and up to
 * twenty-five symbol nodes per file, then episodic extraction adds memories and
 * edges on top — hundreds of mutations within a second or two. Emitting per write
 * would flood every connected client and, worse, make the graph view refetch and
 * re-lay-out repeatedly while the writes were still landing. One event on the
 * trailing edge is what a viewer actually needs.
 *
 * It is a doorbell, not a delivery: the payload carries a reason and nothing
 * else. Diffing the graph over the wire would mean maintaining a second
 * serialization alongside `memory:graph` for a refetch that costs milliseconds.
 */

import { ws } from '$backend/utils/ws';
import { scheduleGraphLayout } from './layout';
import { debug } from '$shared/utils/logger';

/**
 * Window over which mutations are folded into one notification.
 *
 * Long enough to cover a turn's ingestion burst, short enough that a user
 * watching the graph sees their conversation appear while they still associate it
 * with what they just said.
 */
const COALESCE_MS = 600;

let timer: ReturnType<typeof setTimeout> | null = null;
let pendingReason = '';
let pendingProjectId: string | null = null;
let statusTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Note that the graph changed. Cheap, idempotent, and safe to call from inside a
 * loop — call it after any write rather than trying to work out whether this
 * particular write was interesting.
 */
export function notifyGraphChanged(reason: string, projectId: string | null = null): void {
	pendingReason = reason;
	pendingProjectId = projectId;

	// The arrangement is derived from the graph, so anything that changes one
	// changes the other. Hanging it off this call rather than off each write path
	// keeps a single answer to "the graph moved" — and the pass debounces far
	// longer than the broadcast does, because a position that settles four
	// seconds late costs nothing while a view that updates four seconds late is
	// the bug this notification exists to fix.
	scheduleGraphLayout();

	if (timer) return;

	timer = setTimeout(() => {
		timer = null;
		broadcastGraphChanged(pendingReason, pendingProjectId);
	}, COALESCE_MS);
	// Housekeeping — never a reason to hold the process open at shutdown.
	timer.unref?.();
}

/**
 * Ring the doorbell without asking for a new arrangement.
 *
 * The layout pass calls this when it has written new positions. It must NOT go
 * through `notifyGraphChanged`, which schedules a layout — a pass announcing its
 * own result would ask for another one, and while that next pass would find
 * nothing to do and return early, a job that re-queues itself every time it
 * succeeds is a shape worth not having.
 *
 * Uncoalesced, because a pass is already debounced by seconds and produces at
 * most one of these.
 */
export function broadcastGraphChanged(reason: string, projectId: string | null = null): void {
	try {
		ws.emit.global('memory:changed', { reason, projectId });
	} catch (error) {
		// A view that misses a refresh is a stale view, not a broken one, and this
		// is called from write paths that must never fail for a UI concern.
		debug.warn('memory', 'Failed to broadcast memory change', error);
	}
}

/**
 * Tell open views that the extraction queue moved.
 *
 * Separate from `notifyGraphChanged` because they answer different questions and
 * fire at different moments: the graph changes when a memory is written, the
 * queue changes when one is enqueued, retried, or gives up — including the case
 * where nothing was written at all, which is exactly when the user most needs to
 * be told something is happening.
 *
 * Coalesced on a shorter window than the graph, because the counts are small and
 * a status that lags behind the thing it describes is worse than no status.
 */
export function notifyMemoryStatus(): void {
	if (statusTimer) return;
	statusTimer = setTimeout(() => {
		statusTimer = null;
		try {
			ws.emit.global('memory:status-changed', {});
		} catch (error) {
			debug.warn('memory', 'Failed to broadcast memory status', error);
		}
	}, 200);
	statusTimer.unref?.();
}

/**
 * Tell open views that setup progressed — the artifact started downloading,
 * landed, failed, or a model was chosen.
 *
 * Uncoalesced, unlike the two above. These transitions are rare (a handful over
 * the life of an install) and each one changes what the banner says, so delaying
 * them buys nothing and makes a progress bar lag behind the download it tracks.
 */
export function notifyMemoryReadiness(): void {
	try {
		ws.emit.global('memory:readiness-changed', {});
	} catch (error) {
		debug.warn('memory', 'Failed to broadcast memory readiness', error);
	}
}
