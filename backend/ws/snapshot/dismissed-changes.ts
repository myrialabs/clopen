/**
 * Snapshot Dismissed-Changes Handler
 *
 * Per-session mark list for files the user has staged/discarded from
 * the "Current state" banner above chat. Stored as a JSON array on the
 * snapshot itself (`dismissed_changes` column) so it syncs across
 * devices and survives refresh/logout.
 *
 * Marking a file does NOT touch `session_changes` — the underlying
 * checkpoint data stays intact for restore.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { snapshotQueries } from '../../database/queries';
import { snapshotService } from '../../snapshot/snapshot-service';
import { requireSessionAccess } from '../access';

export const dismissedChangesHandler = createRouter()
	.http('snapshot:get-dismissed-changes', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			files: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		return { files: snapshotQueries.getDismissedChanges(data.sessionId) };
	})

	.http('snapshot:remove-session-change', {
		data: t.Object({
			sessionId: t.String(),
			filepath: t.String()
		}),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		const ok = snapshotService.removeFileFromCurrentSessionChanges(data.sessionId, data.filepath);
		return { ok };
	})

	.http('snapshot:remove-session-changes', {
		data: t.Object({
			sessionId: t.String(),
			filepaths: t.Array(t.String(), { minItems: 1 })
		}),
		response: t.Object({
			removed: t.Number(),
			remaining: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		return snapshotService.removeFilesFromCurrentSessionChanges(data.sessionId, data.filepaths);
	})
	
	.http('snapshot:add-dismissed-changes', {
		data: t.Object({
			sessionId: t.String(),
			filepaths: t.Array(t.String())
		}),
		response: t.Object({
			files: t.Array(t.String())
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		const result = snapshotQueries.addDismissedChanges(data.sessionId, data.filepaths);
		return { files: result ?? [] };
	})

	.		http('snapshot:clear-dismissed-changes', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			cleared: t.Boolean()
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		const cleared = snapshotQueries.clearDismissedChanges(data.sessionId);
		return { cleared };
	})

	.http('snapshot:clear-session-changes', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			cleared: t.Number()
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);
		const cleared = snapshotService.clearSessionChanges(data.sessionId);
		return { cleared };
	});
