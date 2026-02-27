/**
 * Migration: Git-Like Commit Graph System
 * Purpose: Implement parent-child relationships for messages (like git commits)
 *
 * Changes:
 * - Add parent_message_id to messages (commit parent pointer)
 * - Add current_head_message_id to chat_sessions (branch HEAD pointer)
 * - Build parent links from existing messages
 * - Clear old branch data (reset is_deleted, branch_id)
 * - Add branches table for tracking named branches
 */

import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Implement git-like commit graph with parent relationships';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Implementing git-like commit graph system...');

	// 1. Add parent_message_id to messages table
	db.exec(`
		ALTER TABLE messages
		ADD COLUMN parent_message_id TEXT
	`);

	// 2. Add current_head_message_id to chat_sessions table
	db.exec(`
		ALTER TABLE chat_sessions
		ADD COLUMN current_head_message_id TEXT
	`);

	// 3. Create branches table for tracking named branches
	db.exec(`
		CREATE TABLE IF NOT EXISTS branches (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			branch_name TEXT NOT NULL,
			head_message_id TEXT NOT NULL,
			created_at TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE,
			FOREIGN KEY (head_message_id) REFERENCES messages(id) ON DELETE CASCADE
		)
	`);

	// 4. Build parent links for existing messages (by timestamp order per session)
	debug.log('migration', '🔗 Building parent links from existing messages...');

	const sessions = db.prepare('SELECT DISTINCT session_id FROM messages').all() as { session_id: string }[];

	for (const { session_id } of sessions) {
		// Get all active messages for this session, ordered by timestamp
		const messages = db.prepare(`
			SELECT id, timestamp
			FROM messages
			WHERE session_id = ? AND (is_deleted IS NULL OR is_deleted = 0)
			ORDER BY timestamp ASC
		`).all(session_id) as { id: string; timestamp: string }[];

		// Build parent links (each message points to previous message)
		for (let i = 1; i < messages.length; i++) {
			db.prepare(`
				UPDATE messages
				SET parent_message_id = ?
				WHERE id = ?
			`).run(messages[i - 1].id, messages[i].id);
		}

		// Set session HEAD to last message
		if (messages.length > 0) {
			const lastMessage = messages[messages.length - 1];
			db.prepare(`
				UPDATE chat_sessions
				SET current_head_message_id = ?
				WHERE id = ?
			`).run(lastMessage.id, session_id);
		}

		debug.log('migration', `  ✓ Built ${messages.length - 1} parent links for session ${session_id}`);
	}

	// 5. Clear old branch data (fresh start)
	debug.log('migration', '🧹 Clearing old branch data...');

	// Reset all is_deleted to 0 (all messages visible again)
	db.exec(`
		UPDATE messages
		SET is_deleted = 0
		WHERE is_deleted = 1
	`);

	// Clear all branch_id (will be reassigned on undo)
	db.exec(`
		UPDATE messages
		SET branch_id = NULL
		WHERE branch_id IS NOT NULL
	`);

	// Clear snapshot soft deletes
	db.exec(`
		UPDATE message_snapshots
		SET is_deleted = 0
		WHERE is_deleted = 1
	`);

	db.exec(`
		UPDATE message_snapshots
		SET branch_id = NULL
		WHERE branch_id IS NOT NULL
	`);

	// 6. Create indexes for fast graph traversal
	db.exec(`
		CREATE INDEX idx_messages_parent_id ON messages(parent_message_id)
	`);

	db.exec(`
		CREATE INDEX idx_messages_session_parent ON messages(session_id, parent_message_id)
	`);

	db.exec(`
		CREATE INDEX idx_branches_session ON branches(session_id)
	`);

	db.exec(`
		CREATE INDEX idx_branches_head ON branches(head_message_id)
	`);

	db.exec(`
		CREATE INDEX idx_chat_sessions_head ON chat_sessions(current_head_message_id)
	`);

	debug.log('migration', '✅ Git-like commit graph system implemented successfully!');
	debug.log('migration', '   📊 All existing messages preserved with parent links');
	debug.log('migration', '   🔄 Old branch data cleared (fresh start)');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing git-like commit graph system...');

	// Drop indexes
	db.exec('DROP INDEX IF EXISTS idx_chat_sessions_head');
	db.exec('DROP INDEX IF EXISTS idx_branches_head');
	db.exec('DROP INDEX IF EXISTS idx_branches_session');
	db.exec('DROP INDEX IF EXISTS idx_messages_session_parent');
	db.exec('DROP INDEX IF EXISTS idx_messages_parent_id');

	// Drop branches table
	db.exec('DROP TABLE IF EXISTS branches');

	// Note: SQLite doesn't support DROP COLUMN easily
	// Columns parent_message_id and current_head_message_id remain but unused
	debug.warn('migration', '⚠️ Columns parent_message_id and current_head_message_id remain but unused');

	debug.log('migration', '✅ Git-like commit graph system rollback completed');
};
