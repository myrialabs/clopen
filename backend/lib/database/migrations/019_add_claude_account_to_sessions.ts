import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add claude_account_id column to chat_sessions for per-session account selection';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding claude_account_id column to chat_sessions...');

	db.exec(`
		ALTER TABLE chat_sessions ADD COLUMN claude_account_id INTEGER DEFAULT NULL
	`);

	debug.log('migration', 'claude_account_id column added to chat_sessions');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'SQLite does not support DROP COLUMN directly, skipping...');
};
