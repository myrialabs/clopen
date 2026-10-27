/**
 * Snapshot Restore Handler (v2 - Session-Scoped with Conflict Detection)
 *
 * Two-phase restore:
 * 1. Check conflicts: detect files modified by other sessions
 * 2. Execute restore: undo session-scoped changes, respecting conflict resolutions
 *
 * The logic lives in `backend/snapshot/restore.ts` so a chat channel can go
 * back to a checkpoint exactly as the web UI does; these routes only check
 * access and delegate.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { checkSessionRestoreConflicts, restoreSessionTo } from '../../snapshot/restore';
import { requireSessionAccess } from '../access';

export const restoreHandler = createRouter()
	/**
	 * Phase 1: Check for conflicts before restore.
	 * Frontend calls this first, and if conflicts exist, shows a modal.
	 */
	.http('snapshot:check-conflicts', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			hasConflicts: t.Boolean(),
			conflicts: t.Array(t.Object({
				filepath: t.String(),
				modifiedBySessionId: t.String(),
				modifiedBySnapshotId: t.String(),
				modifiedAt: t.String(),
				restoreContent: t.Optional(t.String()),
				currentContent: t.Optional(t.String()),
				reason: t.Optional(t.Union([t.Literal('cross-session'), t.Literal('local')]))
			})),
			checkpointsToUndo: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		const { messageId, sessionId } = data;
		requireSessionAccess(conn, sessionId);

		const result = await checkSessionRestoreConflicts(sessionId, messageId);
		debug.log('snapshot', `Conflict check: ${result.conflicts.length} conflicts, ${result.checkpointsToUndo.length} checkpoints to undo`);
		return result;
	})

	/**
	 * Phase 2: Execute restore with optional conflict resolutions.
	 */
	.http('snapshot:restore', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String(),
			conflictResolutions: t.Optional(t.Record(t.String(), t.Union([
				t.Literal('restore'),
				t.Literal('keep')
			])))
		}),
		response: t.Object({
			restoredTo: t.Object({
				messageId: t.String(),
				timestamp: t.String()
			}),
			filesRestored: t.Optional(t.Number()),
			filesSkipped: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const { messageId, sessionId, conflictResolutions } = data;
		requireSessionAccess(conn, sessionId);
		return restoreSessionTo(sessionId, messageId, conflictResolutions);
	});
