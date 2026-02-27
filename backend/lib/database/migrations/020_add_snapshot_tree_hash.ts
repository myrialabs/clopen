/**
 * Migration: Add tree_hash column to message_snapshots
 * Purpose: Support blob-store format where file contents are stored externally
 * in ~/.clopen/snapshots/ instead of in the database.
 *
 * When tree_hash is not null, the snapshot uses the new blob-store format:
 * - files_snapshot = '{}' (empty, content is in blob store)
 * - delta_changes contains hash references instead of full file content
 * - Tree file at ~/.clopen/snapshots/trees/{snapshotId}.json maps filepath -> blob hash
 * - Blobs at ~/.clopen/snapshots/blobs/{hash[0:2]}/{hash}.gz contain compressed file content
 */

import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add tree_hash for blob-store snapshot format';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding tree_hash column to message_snapshots...');

	db.exec(`
		ALTER TABLE message_snapshots
		ADD COLUMN tree_hash TEXT
	`);

	debug.log('migration', 'tree_hash column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing tree_hash column...');
	debug.warn('migration', 'Rollback not implemented for tree_hash (SQLite limitation)');
};
