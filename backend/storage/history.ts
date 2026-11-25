/** What each cleanup removed, for the history list in Settings → Storage. */

import { getDatabase } from '$backend/database';
import type { CleanupActionId, StorageCleanupRun } from '$shared/types/storage';

/** Older runs are dropped; the list is a recent-activity view, not an audit log. */
const KEEP_RUNS = 200;

export function recordCleanupRun(run: Omit<StorageCleanupRun, 'id'>): void {
	const db = getDatabase();
	db.prepare(`
		INSERT INTO storage_cleanup_runs (action, trigger, started_at, finished_at, freed_bytes, items, error)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`).run(run.action, run.trigger, run.startedAt, run.finishedAt, run.freedBytes, run.items, run.error);
	db.prepare(`
		DELETE FROM storage_cleanup_runs
		WHERE id NOT IN (SELECT id FROM storage_cleanup_runs ORDER BY id DESC LIMIT ?)
	`).run(KEEP_RUNS);
}

export function listCleanupRuns(limit = 50): StorageCleanupRun[] {
	const rows = getDatabase().prepare(`
		SELECT id, action, trigger, started_at, finished_at, freed_bytes, items, error
		FROM storage_cleanup_runs ORDER BY id DESC LIMIT ?
	`).all(limit) as {
		id: number; action: string; trigger: string; started_at: string; finished_at: string | null;
		freed_bytes: number; items: number; error: string | null;
	}[];
	return rows.map(row => ({
		id: row.id,
		action: row.action as CleanupActionId,
		trigger: row.trigger as StorageCleanupRun['trigger'],
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		freedBytes: row.freed_bytes,
		items: row.items,
		error: row.error
	}));
}
