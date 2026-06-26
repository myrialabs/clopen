import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create skills table for user-managed Agent Skills (SKILL.md)';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating skills table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS skills (
			id             INTEGER  PRIMARY KEY AUTOINCREMENT,
			slug           TEXT     NOT NULL UNIQUE,
			name           TEXT     NOT NULL,
			description    TEXT     NOT NULL DEFAULT '',
			source         TEXT     NOT NULL DEFAULT 'custom',
			marketplace_ref TEXT,
			version        TEXT,
			license        TEXT,
			is_enabled     INTEGER  NOT NULL DEFAULT 1,
			created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'skills table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping skills table...');
	db.exec('DROP TABLE IF EXISTS skills');
	debug.log('migration', 'skills table dropped');
};
