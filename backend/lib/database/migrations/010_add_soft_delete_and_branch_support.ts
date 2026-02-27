/**
 * Migration: Add soft delete and branch support for undo/redo feature
 * Purpose: Enable multi-branch redo functionality with soft deletes
 */

import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add soft delete and branch support for multi-branch redo';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Adding soft delete and branch support...');

	// Add columns to messages table
	db.exec(`
		ALTER TABLE messages
		ADD COLUMN is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1))
	`);

	db.exec(`
		ALTER TABLE messages
		ADD COLUMN branch_id TEXT
	`);

	// Add columns to message_snapshots table
	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN is_deleted INTEGER DEFAULT 0 CHECK(is_deleted IN (0, 1))
	`);

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN branch_id TEXT
	`);

	// Create indexes for efficient queries
	db.exec(`
		CREATE INDEX idx_messages_is_deleted ON messages(is_deleted)
	`);

	db.exec(`
		CREATE INDEX idx_messages_branch_id ON messages(branch_id)
	`);

	db.exec(`
		CREATE INDEX idx_message_snapshots_is_deleted ON message_snapshots(is_deleted)
	`);

	db.exec(`
		CREATE INDEX idx_message_snapshots_branch_id ON message_snapshots(branch_id)
	`);

	debug.log('migration', '✅ Soft delete and branch support added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing soft delete and branch support...');

	// Drop indexes
	db.exec('DROP INDEX IF EXISTS idx_message_snapshots_branch_id');
	db.exec('DROP INDEX IF EXISTS idx_message_snapshots_is_deleted');
	db.exec('DROP INDEX IF EXISTS idx_messages_branch_id');
	db.exec('DROP INDEX IF EXISTS idx_messages_is_deleted');

	// SQLite doesn't support DROP COLUMN easily without recreating table
	// For rollback, we'd need to recreate tables without these columns
	debug.warn('migration', '⚠️ Full rollback not implemented - columns remain but unused');

	debug.log('migration', '✅ Soft delete and branch support rollback completed');
};
