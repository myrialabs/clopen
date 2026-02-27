import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add delta snapshot support for efficient storage';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Adding delta snapshot fields...');

	// Add new columns for delta snapshots
	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN snapshot_type TEXT DEFAULT 'full' CHECK(snapshot_type IN ('full', 'delta'))
	`);

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN parent_snapshot_id TEXT
	`);

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN delta_changes TEXT
	`);

	// Create index for parent lookup
	db.exec(`
		CREATE INDEX idx_message_snapshots_parent ON message_snapshots(parent_snapshot_id)
	`);

	debug.log('migration', '✅ Delta snapshot fields added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing delta snapshot fields...');

	// SQLite doesn't support DROP COLUMN easily, so we'd need to recreate table
	// For now, this is a forward-only migration
	debug.warn('migration', '⚠️ Rollback not implemented for delta snapshot fields');

	debug.log('migration', '✅ Delta snapshot fields rollback skipped');
};
