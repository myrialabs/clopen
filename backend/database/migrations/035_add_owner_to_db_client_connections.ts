import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Add owner_user_id to db_client_connections table';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding owner_user_id to db_client_connections...');

	// SQLite does not support IF NOT EXISTS for ADD COLUMN, so we ignore duplicate-column errors.
	try {
		db.exec(`
			ALTER TABLE db_client_connections
			ADD COLUMN owner_user_id TEXT
		`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.toLowerCase().includes('duplicate column name')) {
			throw error;
		}
	}

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_client_conn_owner
		ON db_client_connections(owner_user_id)
	`);

	debug.log('migration', 'owner_user_id migration completed');
};

export const down = (db: DatabaseConnection): void => {
	// SQLite cannot drop columns without table rebuild; keep rollback non-destructive.
	debug.log('migration', 'Dropping idx_db_client_conn_owner index...');
	db.exec('DROP INDEX IF EXISTS idx_db_client_conn_owner');
};
