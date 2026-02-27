import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create settings table for storing application configuration';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating settings table...');
	
	db.exec(`
		CREATE TABLE settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	debug.log('migration', '✅ Settings table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping settings table...');
	db.exec('DROP TABLE IF EXISTS settings');
	debug.log('migration', '✅ Settings table dropped');
};