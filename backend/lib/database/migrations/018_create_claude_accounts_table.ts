import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create claude_accounts table for multi-account management';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating claude_accounts table...');
	db.exec(`
		CREATE TABLE IF NOT EXISTS claude_accounts (
			id         INTEGER  PRIMARY KEY AUTOINCREMENT,
			name       TEXT     NOT NULL,
			oauth_token TEXT    NOT NULL,
			is_active  INTEGER  NOT NULL DEFAULT 0,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);
	debug.log('migration', 'claude_accounts table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping claude_accounts table...');
	db.exec('DROP TABLE IF EXISTS claude_accounts');
	debug.log('migration', 'claude_accounts table dropped');
};
