/**
 * Migration: Worktrees — isolated copies of a project that sessions can run in.
 * Purpose: let several tasks run in parallel without touching the main tree.
 */

import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create worktrees table and bind chat sessions to a worktree';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating worktrees table...');

	// `base_tree` is the merge base: a TreeMap (relative path → blob hash) of the
	// main tree captured when the worktree was cloned. Apply/sync compare against
	// it, so it must survive restarts — hence a column rather than memory.
	db.exec(`
		CREATE TABLE IF NOT EXISTS worktrees (
			id              TEXT PRIMARY KEY,
			project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
			name            TEXT NOT NULL,
			slug            TEXT NOT NULL,
			path            TEXT NOT NULL,
			status          TEXT NOT NULL DEFAULT 'active'
			                CHECK (status IN ('active','applied','archived')),
			clone_mode      TEXT NOT NULL DEFAULT 'copy'
			                CHECK (clone_mode IN ('reflink','copy')),
			base_tree       TEXT NOT NULL,
			created_by      TEXT,
			created_at      TEXT NOT NULL,
			last_opened_at  TEXT,
			last_applied_at TEXT
		)
	`);

	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_project_slug
		ON worktrees(project_id, slug)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_worktrees_project
		ON worktrees(project_id)
	`);

	debug.log('migration', '📋 Binding chat sessions to worktrees...');

	// NULL = the session runs in the main project tree.
	db.exec(`ALTER TABLE chat_sessions ADD COLUMN worktree_id TEXT`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_chat_sessions_worktree
		ON chat_sessions(worktree_id)
	`);

	debug.log('migration', '✅ Worktrees ready');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping worktrees...');
	db.exec('DROP INDEX IF EXISTS idx_chat_sessions_worktree');
	db.exec('DROP INDEX IF EXISTS idx_worktrees_project');
	db.exec('DROP INDEX IF EXISTS idx_worktrees_project_slug');
	db.exec('DROP TABLE IF EXISTS worktrees');
	debug.warn('migration', '⚠️ chat_sessions.worktree_id remains (SQLite drop-column)');
	debug.log('migration', '✅ Worktrees rollback completed');
};
