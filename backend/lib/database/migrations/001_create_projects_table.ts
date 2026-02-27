import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create projects table for storing project information';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating projects table...');
	
	db.exec(`
		CREATE TABLE projects (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			path TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL,
			last_opened_at TEXT NOT NULL
		)
	`);

	// Create index for performance
	db.exec(`
		CREATE INDEX idx_projects_last_opened ON projects(last_opened_at)
	`);

	debug.log('migration', '✅ Projects table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping projects table...');
	db.exec('DROP TABLE IF EXISTS projects');
	debug.log('migration', '✅ Projects table dropped');
};