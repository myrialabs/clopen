import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create query_history table for SQL editor history tracking';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating query_history table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS query_history (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			connection_name TEXT NOT NULL,
			connection_type TEXT NOT NULL,
			sql TEXT NOT NULL,
			execution_time_ms INTEGER NOT NULL DEFAULT 0,
			row_count INTEGER NOT NULL DEFAULT 0,
			error TEXT,
			executed_at TEXT NOT NULL,
			is_favorite INTEGER NOT NULL DEFAULT 0
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_query_history_connection_id ON query_history(connection_id);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_query_history_executed_at ON query_history(executed_at DESC);
	`);

	debug.log('migration', 'query_history table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping query_history table...');
	db.exec('DROP TABLE IF EXISTS query_history');
	debug.log('migration', 'query_history table dropped');
};
