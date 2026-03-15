import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create schema_versions table for schema change tracking and rollback';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating schema_versions table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_versions (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			connection_name TEXT NOT NULL,
			connection_type TEXT NOT NULL,
			table_name TEXT NOT NULL,
			schema_name TEXT,
			version_number INTEGER NOT NULL,
			label TEXT,
			up_sql TEXT NOT NULL,
			down_sql TEXT NOT NULL,
			changes_json TEXT NOT NULL,
			columns_before_json TEXT NOT NULL,
			columns_after_json TEXT NOT NULL,
			applied_by_id TEXT NOT NULL,
			applied_by_name TEXT NOT NULL,
			applied_at TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'applied',
			notes TEXT
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_schema_versions_connection
		ON schema_versions(connection_id, table_name);
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_schema_versions_applied_at
		ON schema_versions(applied_at DESC);
	`);

	db.exec(`
		CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_versions_version_num
		ON schema_versions(connection_id, table_name, version_number);
	`);

	debug.log('migration', 'schema_versions table created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping schema_versions table...');
	db.exec('DROP TABLE IF EXISTS schema_versions');
	debug.log('migration', 'schema_versions table dropped');
};
