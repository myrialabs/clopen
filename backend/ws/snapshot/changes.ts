/**
 * Snapshot Changes Handler
 *
 * Returns the list of files changed in a checkpoint. Accumulates
 * `session_changes` across ALL snapshots for the session (oldest first,
 * latest wins per filepath) so the banner keeps showing files from
 * earlier AI turns until the user stages or discards them — matching
 * the worktree's "current state" semantics.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { snapshotQueries } from '../../database/queries';
import { requireSessionAccess } from '../access';

export const changesHandler = createRouter()
	.http('snapshot:get-changes', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			files: t.Array(t.Object({
				filepath: t.String(),
				oldHash: t.String(),
				newHash: t.String()
			}))
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		// Accumulate session_changes across every snapshot for the session.
		// For each filepath:
		//   - `oldHash` is taken from the FIRST snapshot that touched the file
		//     (i.e. the pre-AI state) so the diff shows the full accumulated
		//     change from original → current, not just the latest delta.
		//   - `newHash` is taken from the LATEST snapshot that touched the
		//     file (the current working-tree state).
		const snapshots = snapshotQueries.getBySessionId(data.sessionId);

		const firstOld: Record<string, string> = {};
		const lastNew: Record<string, string> = {};
		for (const snap of snapshots) {
			if (!snap.session_changes) continue;
			try {
				const changes = JSON.parse(snap.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
				for (const [filepath, entry] of Object.entries(changes)) {
					if (!(filepath in firstOld)) {
						firstOld[filepath] = entry.oldHash || '';
					}
					lastNew[filepath] = entry.newHash || '';
				}
			} catch {
				// Skip snapshots with corrupt session_changes JSON
			}
		}

		const files = Object.keys(lastNew).map(filepath => ({
			filepath,
			oldHash: firstOld[filepath] || '',
			newHash: lastNew[filepath] || ''
		}));
		return { files };
	});
