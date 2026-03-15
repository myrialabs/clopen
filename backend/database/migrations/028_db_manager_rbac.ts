import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create db_connection_permissions and db_audit_log tables for Database Manager RBAC';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating db_connection_permissions table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_connection_permissions (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			role TEXT NOT NULL CHECK(role IN ('owner', 'developer', 'viewer')),
			granted_by TEXT NOT NULL,
			granted_at TEXT NOT NULL,
			UNIQUE(connection_id, user_id)
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_conn_perms_connection_id
		ON db_connection_permissions(connection_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_conn_perms_user_id
		ON db_connection_permissions(user_id)
	`);

	debug.log('migration', 'Creating db_audit_log table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_audit_log (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			connection_name TEXT NOT NULL,
			user_id TEXT NOT NULL,
			user_name TEXT NOT NULL,
			action TEXT NOT NULL,
			sql TEXT,
			table_name TEXT,
			row_count INTEGER,
			execution_time_ms INTEGER,
			success INTEGER NOT NULL DEFAULT 1,
			error TEXT,
			ip_address TEXT,
			performed_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_audit_log_connection_id
		ON db_audit_log(connection_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_audit_log_user_id
		ON db_audit_log(user_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_audit_log_performed_at
		ON db_audit_log(performed_at DESC)
	`);

	debug.log('migration', 'db_connection_permissions and db_audit_log tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping db_audit_log and db_connection_permissions tables...');
	db.exec('DROP TABLE IF EXISTS db_audit_log');
	db.exec('DROP TABLE IF EXISTS db_connection_permissions');
	debug.log('migration', 'Tables dropped');
};
