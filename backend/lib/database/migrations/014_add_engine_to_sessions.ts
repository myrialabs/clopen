import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add engine column to chat_sessions table for multi-engine support';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', '🔧 Adding engine column to chat_sessions...');

	db.exec(`
		ALTER TABLE chat_sessions ADD COLUMN engine TEXT DEFAULT 'claude-code'
	`);

	debug.log('migration', '✅ Engine column added to chat_sessions');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', '🗑️ SQLite does not support DROP COLUMN directly, skipping...');
};
