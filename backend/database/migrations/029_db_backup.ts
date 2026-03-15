import type { DatabaseConnection } from '$shared/types/database/connection';
import { debug } from '$shared/utils/logger';

export const description = 'Create db_backup_configs and db_backup_runs tables for Automated Backup';

export const up = (db: DatabaseConnection): void => {
	debug.log('migration', 'Creating db_backup_configs table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_backup_configs (
			id TEXT PRIMARY KEY,
			connection_id TEXT NOT NULL,
			name TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1,
			provider TEXT NOT NULL CHECK(provider IN ('aws-s3', 'gcs')),
			frequency TEXT NOT NULL CHECK(frequency IN ('hourly', 'daily', 'weekly', 'monthly')),
			hour INTEGER NOT NULL DEFAULT 0,
			day_of_week INTEGER,
			day_of_month INTEGER,
			bucket TEXT NOT NULL,
			prefix TEXT NOT NULL DEFAULT 'clopen-backups/',
			aws_region TEXT,
			aws_access_key_id TEXT,
			aws_secret_access_key TEXT,
			gcs_project_id TEXT,
			gcs_client_email TEXT,
			gcs_private_key TEXT,
			retention_days INTEGER NOT NULL DEFAULT 30,
			last_run_at TEXT,
			last_run_success INTEGER,
			last_run_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_backup_configs_connection_id
		ON db_backup_configs(connection_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_backup_configs_enabled
		ON db_backup_configs(enabled)
	`);

	debug.log('migration', 'Creating db_backup_runs table...');

	db.exec(`
		CREATE TABLE IF NOT EXISTS db_backup_runs (
			id TEXT PRIMARY KEY,
			config_id TEXT NOT NULL,
			connection_id TEXT NOT NULL,
			connection_name TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			success INTEGER NOT NULL DEFAULT 0,
			file_size INTEGER,
			storage_path TEXT,
			error TEXT
		)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_backup_runs_config_id
		ON db_backup_runs(config_id)
	`);

	db.exec(`
		CREATE INDEX IF NOT EXISTS idx_db_backup_runs_started_at
		ON db_backup_runs(started_at DESC)
	`);

	debug.log('migration', 'db_backup_configs and db_backup_runs tables created');
};

export const down = (db: DatabaseConnection): void => {
	debug.log('migration', 'Dropping backup tables...');
	db.exec('DROP TABLE IF EXISTS db_backup_runs');
	db.exec('DROP TABLE IF EXISTS db_backup_configs');
	debug.log('migration', 'Backup tables dropped');
};
