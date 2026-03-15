import { getDatabase } from '../index';
import type { BackupConfig, BackupRun } from '$shared/types/db-export';

// ─── Row mappers ──────────────────────────────────────────────────────────────

function toConfig(row: Record<string, unknown>): BackupConfig {
	return {
		id: row.id as string,
		connectionId: row.connection_id as string,
		name: row.name as string,
		enabled: Boolean(row.enabled),
		provider: row.provider as BackupConfig['provider'],
		frequency: row.frequency as BackupConfig['frequency'],
		hour: row.hour as number,
		dayOfWeek: row.day_of_week !== null ? (row.day_of_week as number) : undefined,
		dayOfMonth: row.day_of_month !== null ? (row.day_of_month as number) : undefined,
		bucket: row.bucket as string,
		prefix: row.prefix as string,
		awsRegion: row.aws_region !== null ? (row.aws_region as string) : undefined,
		awsAccessKeyId: row.aws_access_key_id !== null ? (row.aws_access_key_id as string) : undefined,
		awsSecretAccessKey: row.aws_secret_access_key !== null ? (row.aws_secret_access_key as string) : undefined,
		gcsProjectId: row.gcs_project_id !== null ? (row.gcs_project_id as string) : undefined,
		gcsClientEmail: row.gcs_client_email !== null ? (row.gcs_client_email as string) : undefined,
		gcsPrivateKey: row.gcs_private_key !== null ? (row.gcs_private_key as string) : undefined,
		retentionDays: row.retention_days as number,
		lastRunAt: row.last_run_at !== null ? (row.last_run_at as string) : undefined,
		lastRunSuccess: row.last_run_success !== null ? Boolean(row.last_run_success) : undefined,
		lastRunError: row.last_run_error !== null ? (row.last_run_error as string) : undefined,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string
	};
}

function toRun(row: Record<string, unknown>): BackupRun {
	return {
		id: row.id as string,
		configId: row.config_id as string,
		connectionId: row.connection_id as string,
		connectionName: row.connection_name as string,
		startedAt: row.started_at as string,
		completedAt: row.completed_at !== null ? (row.completed_at as string) : undefined,
		success: Boolean(row.success),
		fileSize: row.file_size !== null ? (row.file_size as number) : undefined,
		storagePath: row.storage_path !== null ? (row.storage_path as string) : undefined,
		error: row.error !== null ? (row.error as string) : undefined
	};
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const dbBackupQueries = {
	listAll(): BackupConfig[] {
		const db = getDatabase();
		return (db.query('SELECT * FROM db_backup_configs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map(toConfig);
	},

	listForConnection(connectionId: string): BackupConfig[] {
		const db = getDatabase();
		return (db
			.query('SELECT * FROM db_backup_configs WHERE connection_id = ? ORDER BY created_at DESC')
			.all(connectionId) as Record<string, unknown>[]).map(toConfig);
	},

	getById(id: string): BackupConfig | null {
		const db = getDatabase();
		const row = db.query('SELECT * FROM db_backup_configs WHERE id = ?').get(id) as Record<string, unknown> | null;
		return row ? toConfig(row) : null;
	},

	listEnabled(): BackupConfig[] {
		const db = getDatabase();
		return (db.query('SELECT * FROM db_backup_configs WHERE enabled = 1').all() as Record<string, unknown>[]).map(toConfig);
	},

	create(config: BackupConfig): void {
		const db = getDatabase();
		db.query(`
			INSERT INTO db_backup_configs (
				id, connection_id, name, enabled, provider, frequency, hour,
				day_of_week, day_of_month, bucket, prefix,
				aws_region, aws_access_key_id, aws_secret_access_key,
				gcs_project_id, gcs_client_email, gcs_private_key,
				retention_days, last_run_at, last_run_success, last_run_error,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			config.id,
			config.connectionId,
			config.name,
			config.enabled ? 1 : 0,
			config.provider,
			config.frequency,
			config.hour,
			config.dayOfWeek ?? null,
			config.dayOfMonth ?? null,
			config.bucket,
			config.prefix,
			config.awsRegion ?? null,
			config.awsAccessKeyId ?? null,
			config.awsSecretAccessKey ?? null,
			config.gcsProjectId ?? null,
			config.gcsClientEmail ?? null,
			config.gcsPrivateKey ?? null,
			config.retentionDays,
			config.lastRunAt ?? null,
			config.lastRunSuccess !== undefined ? (config.lastRunSuccess ? 1 : 0) : null,
			config.lastRunError ?? null,
			config.createdAt,
			config.updatedAt
		);
	},

	update(id: string, data: Partial<Omit<BackupConfig, 'id' | 'connectionId' | 'createdAt'>>): void {
		const db = getDatabase();
		const now = new Date().toISOString();
		const parts: string[] = ['updated_at = ?'];
		const values: unknown[] = [now];

		const colMap: Record<string, string> = {
			name: 'name',
			enabled: 'enabled',
			provider: 'provider',
			frequency: 'frequency',
			hour: 'hour',
			dayOfWeek: 'day_of_week',
			dayOfMonth: 'day_of_month',
			bucket: 'bucket',
			prefix: 'prefix',
			awsRegion: 'aws_region',
			awsAccessKeyId: 'aws_access_key_id',
			awsSecretAccessKey: 'aws_secret_access_key',
			gcsProjectId: 'gcs_project_id',
			gcsClientEmail: 'gcs_client_email',
			gcsPrivateKey: 'gcs_private_key',
			retentionDays: 'retention_days',
			lastRunAt: 'last_run_at',
			lastRunSuccess: 'last_run_success',
			lastRunError: 'last_run_error'
		};

		for (const [key, col] of Object.entries(colMap)) {
			if (!(key in data)) continue;
			parts.push(`${col} = ?`);
			let val: unknown = (data as Record<string, unknown>)[key] ?? null;
			if (key === 'enabled') val = val ? 1 : 0;
			if (key === 'lastRunSuccess') val = val !== null ? (val ? 1 : 0) : null;
			values.push(val);
		}

		values.push(id);
		db.query(`UPDATE db_backup_configs SET ${parts.join(', ')} WHERE id = ?`).run(...values);
	},

	delete(id: string): void {
		const db = getDatabase();
		db.query('DELETE FROM db_backup_runs WHERE config_id = ?').run(id);
		db.query('DELETE FROM db_backup_configs WHERE id = ?').run(id);
	},

	addRun(run: BackupRun): void {
		const db = getDatabase();
		db.query(`
			INSERT INTO db_backup_runs (
				id, config_id, connection_id, connection_name, started_at,
				completed_at, success, file_size, storage_path, error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			run.id,
			run.configId,
			run.connectionId,
			run.connectionName,
			run.startedAt,
			run.completedAt ?? null,
			run.success ? 1 : 0,
			run.fileSize ?? null,
			run.storagePath ?? null,
			run.error ?? null
		);
	},

	getRuns(configId: string, limit = 50): BackupRun[] {
		const db = getDatabase();
		return (db
			.query('SELECT * FROM db_backup_runs WHERE config_id = ? ORDER BY started_at DESC LIMIT ?')
			.all(configId, limit) as Record<string, unknown>[]).map(toRun);
	},

	pruneRuns(configId: string, retentionDays: number): void {
		const db = getDatabase();
		const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
		db.query('DELETE FROM db_backup_runs WHERE config_id = ? AND started_at < ?').run(configId, cutoff);
	}
};
