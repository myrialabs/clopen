import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create sql_snippets table for SQL Snippets Cloud';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating sql_snippets table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS sql_snippets (
			id TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			sql TEXT NOT NULL,
			tags TEXT NOT NULL DEFAULT '[]',
			is_public INTEGER NOT NULL DEFAULT 0,
			share_token TEXT UNIQUE,
			created_by TEXT NOT NULL,
			created_by_name TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_snippets_created_by
		ON sql_snippets(created_by)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_snippets_is_public
		ON sql_snippets(is_public)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_snippets_share_token
		ON sql_snippets(share_token)
	`);

	debug.log('migration', 'sql_snippets table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping sql_snippets table...');
	db.exec('DROP TABLE IF EXISTS sql_snippets');
	debug.log('migration', 'sql_snippets table dropped');
};
