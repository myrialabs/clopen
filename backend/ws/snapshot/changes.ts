/**
 * Snapshot Changes Handler
 *
 * Returns the list of files changed in a checkpoint. Accumulates
 * `session_changes` across ALL snapshots for the session (oldest first,
 * latest wins per filepath) so the banner keeps showing files from
 * earlier AI turns until the user stages or discards them — matching
 * the worktree's "current state" semantics.
 *
 * Also filters out files that no longer exist in the working tree
 * (e.g. after a restore that deleted them) so the banner doesn't show
 * ghosts.
 *
 * Per-file line counts (additions/deletions) are computed by diffing
 * the blob-stored `oldHash` content against the current worktree file
 * via `getDetailedFileDiffs` — same data source as the rest of the
 * snapshot pipeline, so the banner matches `git diff --stat` exactly.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { snapshotQueries, sessionQueries, projectQueries } from '../../database/queries';
import { requireSessionAccess } from '../access';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { blobStore } from '../../snapshot/blob-store';
import { getDetailedFileDiffs } from '$shared/utils/diff-calculator';
import { debug } from '$shared/utils/logger';

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
				newHash: t.String(),
				additions: t.Number(),
				deletions: t.Number()
			}))
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		// Accumulate session_changes across every snapshot for the session.
		// For each filepath:
		//   - `oldHash` is taken from the LATEST snapshot that touched the file
		//     so the diff matches the worktree's `git diff` (which compares
		//     against the last committed/known state, not the original pre-AI state).
		//   - `newHash` is taken from the LATEST snapshot that touched the
		//     file (the current working-tree state).
		const snapshots = snapshotQueries.getBySessionId(data.sessionId);

		const lastOld: Record<string, string> = {};
		const lastNew: Record<string, string> = {};
		for (const snap of snapshots) {
			if (!snap.session_changes) continue;
			try {
				const changes = JSON.parse(snap.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
				for (const [filepath, entry] of Object.entries(changes)) {
					lastOld[filepath] = entry.oldHash || '';
					lastNew[filepath] = entry.newHash || '';
				}
			} catch {
				// Skip snapshots with corrupt session_changes JSON
			}
		}

		// Drop files that no longer exist in the working tree (e.g. a
		// restore that deleted them). Without this, the banner would show
		// ghost entries that don't match the worktree.
		const session = sessionQueries.getById(data.sessionId);
		const project = session ? projectQueries.getById(session.project_id) : null;
		const projectPath = project?.path || '';

		const visibleFilepaths = Object.keys(lastNew).filter(filepath => {
			if (!projectPath) return true;
			return existsSync(join(projectPath, filepath));
		});

		// Compute insertions/deletions per file by diffing the blob-stored
		// old content against the current worktree file. Missing blob
		// (e.g. legacy snapshots without blob store) or unreadable file
		// falls back to 0/0 so the banner still renders without failing
		// the whole request.
		const previousSnapshot: Record<string, Buffer> = {};
		const currentSnapshot: Record<string, Buffer> = {};
		for (const filepath of visibleFilepaths) {
			const oldHash = lastOld[filepath];
			if (oldHash) {
				try {
					previousSnapshot[filepath] = await blobStore.readBlob(oldHash);
				} catch (err) {
					debug.warn('snapshot', `Missing blob for ${filepath} (${oldHash}):`, err);
				}
			}
			if (projectPath) {
				try {
					currentSnapshot[filepath] = await readFile(join(projectPath, filepath));
				} catch (err) {
					debug.warn('snapshot', `Unreadable worktree file ${filepath}:`, err);
				}
			}
		}

		const diffMap = new Map<string, { insertions: number; deletions: number }>();
		try {
			for (const d of getDetailedFileDiffs(previousSnapshot, currentSnapshot)) {
				diffMap.set(d.filepath, { insertions: d.insertions, deletions: d.deletions });
			}
		} catch (err) {
			debug.warn('snapshot', 'Diff calculation failed, defaulting to 0/0:', err);
		}

		const files = visibleFilepaths.map(filepath => {
			const stats = diffMap.get(filepath);
			return {
				filepath,
				oldHash: lastOld[filepath] || '',
				newHash: lastNew[filepath] || '',
				additions: stats?.insertions ?? 0,
				deletions: stats?.deletions ?? 0
			};
		});
		return { files };
	});
