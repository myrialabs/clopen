import type { DatabaseConnection } from '$shared/types/database/connection';

import { debug } from '$shared/utils/logger';
export const description = 'Add model column to chat_sessions table for model persistence';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Adding model column to chat_sessions...');

	db.exec(`
		ALTER TABLE chat_sessions ADD COLUMN model TEXT DEFAULT NULL
	`);

	debug.log('migration', 'Model column added to chat_sessions');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'SQLite does not support DROP COLUMN directly, skipping...');
};
