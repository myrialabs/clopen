import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create subagents table for user-managed custom subagents';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating subagents table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS subagents (
			id             INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug           TEXT     NOT NULL UNIQUE,
			name           TEXT     NOT NULL,
			description    TEXT     NOT NULL DEFAULT '',
			tools          TEXT,
			model          TEXT,
			agent_type     TEXT,
			source         TEXT     NOT NULL DEFAULT 'custom',
			is_enabled     INTEGER  NOT NULL DEFAULT 1,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'subagents table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping subagents table...');
	db.exec('DROP TABLE IF EXISTS subagents');
	debug.log('migration', 'subagents table dropped');
};
