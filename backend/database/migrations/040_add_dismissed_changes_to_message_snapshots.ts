import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add dismissed_changes to message_snapshots for per-session file dismissal marks';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding dismissed_changes to message_snapshots...');
	db.exec(`ALTER TABLE message_snapshots ADD COLUMN dismissed_changes TEXT`);
	debug.log('migration', 'dismissed_changes column added');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Removing dismissed_changes from message_snapshots...');
	db.exec(`
		CREATE TABLE message_snapshots_backup AS
		SELECT id, message_id, session_id, project_id, files_snapshot, project_metadata,
			created_at, snapshot_type, parent_snapshot_id, delta_changes, files_changed,
			insertions, deletions, branch_id, tree_hash, session_changes, is_deleted
		FROM message_snapshots
	`);
	db.exec(`DROP TABLE message_snapshots`);
	db.exec(`ALTER TABLE message_snapshots_backup RENAME TO message_snapshots`);
	debug.log('migration', 'dismissed_changes column removed');
};
