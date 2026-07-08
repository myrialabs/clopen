import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create commands table for user-managed custom slash commands';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating commands table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS commands (
			id             INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug           TEXT     NOT NULL UNIQUE,
			name           TEXT     NOT NULL,
			description    TEXT     NOT NULL DEFAULT '',
			argument_hint  TEXT,
			model          TEXT,
			source         TEXT     NOT NULL DEFAULT 'custom',
			is_enabled     INTEGER  NOT NULL DEFAULT 1,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'commands table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping commands table...');
	db.exec('DROP TABLE IF EXISTS commands');
	debug.log('migration', 'commands table dropped');
};
