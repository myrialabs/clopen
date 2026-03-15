import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description =
	'Add before_data, after_data, pk_column, pk_value snapshot columns to db_audit_log for rollback support';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding snapshot diff columns to db_audit_log...');

	db.exec('ALTER TABLE db_audit_log ADD COLUMN before_data TEXT');
	db.exec('ALTER TABLE db_audit_log ADD COLUMN after_data TEXT');
	db.exec('ALTER TABLE db_audit_log ADD COLUMN pk_column TEXT');
	db.exec('ALTER TABLE db_audit_log ADD COLUMN pk_value TEXT');

	debug.log('migration', 'Snapshot diff columns added to db_audit_log');
};

export const down = (_db: DatabaseConnection): void => {
	// SQLite does not support DROP COLUMN on all versions; columns are left in place.
	debug.log('migration', '032 down: snapshot columns left in db_audit_log (SQLite limitation)');
};
