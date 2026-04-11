import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create opencode_accounts table for per-provider multi-account management';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating opencode_accounts table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS opencode_accounts (
			id          INTEGER  PRIMARY KEY AUTOINCREMENT,
			provider_id INTEGER  NOT NULL REFERENCES opencode_providers(id) ON DELETE CASCADE,
			name        TEXT     NOT NULL,
			api_key     TEXT     NOT NULL,
			is_active   INTEGER  NOT NULL DEFAULT 0,
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'opencode_accounts table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping opencode_accounts table...');
	db.exec('DROP TABLE IF EXISTS opencode_accounts');
	debug.log('migration', 'opencode_accounts table dropped');
};
