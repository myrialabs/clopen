import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add user identification fields to messages table for shared chat';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '📋 Adding user fields to messages table...');
	
	// Add sender_id and sender_name columns to messages table
	db.exec(`
		ALTER TABLE messages 
		ADD COLUMN sender_id TEXT;
	`);
	
	db.exec(`
		ALTER TABLE messages 
		ADD COLUMN sender_name TEXT;
	`);
	
	// Create index for sender_id for performance
	db.exec(`
		CREATE INDEX idx_messages_sender_id ON messages(sender_id);
	`);
	
	debug.log('migration', '✅ User fields added to messages table');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ Removing user fields from messages table...');
	
	// SQLite doesn't support dropping columns directly, need to recreate table
	db.exec(`
		-- Create temporary table without user fields
		CREATE TABLE messages_temp (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			sdk_message TEXT NOT NULL,
			FOREIGN KEY (session_id) REFERENCES chat_sessions(id)
		);
		
		-- Copy data
		INSERT INTO messages_temp (id, session_id, timestamp, sdk_message)
		SELECT id, session_id, timestamp, sdk_message FROM messages;
		
		-- Drop original table
		DROP TABLE messages;
		
		-- Rename temp table
		ALTER TABLE messages_temp RENAME TO messages;
		
		-- Recreate indexes
		CREATE INDEX idx_messages_session_id ON messages(session_id);
		CREATE INDEX idx_messages_timestamp ON messages(timestamp);
	`);
	
	debug.log('migration', '✅ User fields removed from messages table');
};