/**
 * Migration: Add file change statistics to message snapshots
 * Purpose: Store git-like file change stats (files changed, insertions, deletions)
 */

import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add file change statistics to message snapshots';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📊 Adding file change statistics fields...');

	// Add columns for file change statistics
	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN files_changed INTEGER DEFAULT 0
	`);

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN insertions INTEGER DEFAULT 0
	`);

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN deletions INTEGER DEFAULT 0
	`);

	debug.log('migration', '✅ File change statistics fields added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing file change statistics fields...');

	// SQLite doesn't support DROP COLUMN easily, so we'd need to recreate table
	// For now, this is a forward-only migration
	debug.warn('migration', '⚠️ Rollback not implemented for file change statistics');

	debug.log('migration', '✅ File change statistics rollback skipped');
};
