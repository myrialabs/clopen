import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create SQL-to-REST API Generator tables';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating SQL REST API tables...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS sql_api_endpoints (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			slug TEXT NOT NULL UNIQUE,
			sql_template TEXT NOT NULL,
			params TEXT NOT NULL DEFAULT '[]',
			is_public INTEGER NOT NULL DEFAULT 0,
			enabled INTEGER NOT NULL DEFAULT 1,
			rate_limit_requests INTEGER NOT NULL DEFAULT 60,
			rate_limit_window_secs INTEGER NOT NULL DEFAULT 60,
			cache_ttl_secs INTEGER NOT NULL DEFAULT 0,
			created_by TEXT NOT NULL,
			created_by_name TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_endpoints_slug
		ON sql_api_endpoints(slug)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_endpoints_connection_id
		ON sql_api_endpoints(connection_id)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS sql_api_keys (
			id TEXT PRIMARY KEY,
			endpoint_id TEXT NOT NULL,
			name TEXT NOT NULL,
			key_hash TEXT NOT NULL UNIQUE,
			key_prefix TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			last_used_at TEXT,
			expires_at TEXT,
			created_by TEXT NOT NULL,
			created_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_keys_endpoint_id
		ON sql_api_keys(endpoint_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_keys_key_hash
		ON sql_api_keys(key_hash)
	`);

	db.exec(`
		CREATE TABLE IF NOT EXISTS sql_api_request_log (
			id TEXT PRIMARY KEY,
			endpoint_id TEXT NOT NULL,
			endpoint_slug TEXT NOT NULL,
			api_key_id TEXT,
			ip_address TEXT,
			params TEXT NOT NULL DEFAULT '{}',
			status_code INTEGER NOT NULL,
			row_count INTEGER,
			execution_time_ms INTEGER,
			error TEXT,
			requested_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_request_log_endpoint_id
		ON sql_api_request_log(endpoint_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_sql_api_request_log_requested_at
		ON sql_api_request_log(requested_at)
	`);

	debug.log('migration', 'SQL REST API tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping SQL REST API tables...');
	db.exec('DROP TABLE IF EXISTS sql_api_request_log');
	db.exec('DROP TABLE IF EXISTS sql_api_keys');
	db.exec('DROP TABLE IF EXISTS sql_api_endpoints');
	debug.log('migration', 'SQL REST API tables dropped');
};
