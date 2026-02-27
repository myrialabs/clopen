import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create chat_sessions table for storing chat conversation sessions';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating chat_sessions table...');
	
	db.exec(`
		CREATE TABLE chat_sessions (
			id TEXT PRIMARY KEY,
			project_id TEXT NOT NULL,
			title TEXT,
			latest_sdk_session_id TEXT,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			FOREIGN KEY (project_id) REFERENCES projects(id)
		)
	`);

	// Create index for performance
	db.exec(`
		CREATE INDEX idx_chat_sessions_project_id ON chat_sessions(project_id)
	`);

	debug.log('migration', '✅ Chat sessions table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping chat_sessions table...');
	db.exec('DROP TABLE IF EXISTS chat_sessions');
	debug.log('migration', '✅ Chat sessions table dropped');
};