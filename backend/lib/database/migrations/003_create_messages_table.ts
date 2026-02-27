import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Create messages table for storing SDKMessage data as JSON';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Creating messages table...');
	
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			sdk_message TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
		)
	`);

	// Create indexes for performance
	db.exec(`
		CREATE INDEX idx_messages_session_id ON messages(session_id);
		CREATE INDEX idx_messages_timestamp ON messages(timestamp)
	`);

	debug.log('migration', '✅ Messages table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Dropping messages table...');
	db.exec('DROP TABLE IF EXISTS messages');
	debug.log('migration', '✅ Messages table dropped');
};