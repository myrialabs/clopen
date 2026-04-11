import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create opencode_providers table for multi-provider management';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating opencode_providers table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS opencode_providers (
			id          INTEGER  PRIMARY KEY AUTOINCREMENT,
			provider_id TEXT     NOT NULL UNIQUE,
			name        TEXT     NOT NULL,
			npm         TEXT     NOT NULL,
			api_url     TEXT,
			options     TEXT     DEFAULT '{}',
			is_enabled  INTEGER  NOT NULL DEFAULT 1,
			created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'opencode_providers table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping opencode_providers table...');
	db.exec('DROP TABLE IF EXISTS opencode_providers');
	debug.log('migration', 'opencode_providers table dropped');
};
