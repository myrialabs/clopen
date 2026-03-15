/**
 * Types for Database Manager: Export, Import, and Automated Backup
 */

// ─── Export ───────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'json' | 'sql';

export interface ExportOptions {
	format: ExportFormat;
	/** Include header row (CSV only) */
	includeHeaders: boolean;
	/** Pretty-print JSON output */
	prettyPrint: boolean;
	/** Include CREATE TABLE statement (SQL only) */
	includeCreateTable: boolean;
	/** Rows per server batch */
	batchSize: number;
}

export interface ExportBatchResult {
	rows: Record<string, unknown>[];
	total: number;
	offset: number;
	done: boolean;
}

// ─── Import ───────────────────────────────────────────────────────────────────

/** Maps a source column (from file) to a target column (in DB table). null = skip */
export interface ColumnMapping {
	sourceColumn: string;
	targetColumn: string | null;
}

export interface ImportPreview {
	headers: string[];
	/** Up to 5 sample rows for column mapping UI */
	sampleRows: Record<string, string>[];
	format: 'csv' | 'json';
}

export interface ImportBatchRequest {
	connectionId: string;
	tableName: string;
	schema?: string;
	rows: Record<string, unknown>[];
	mappings: ColumnMapping[];
	skipErrors: boolean;
}

export interface ImportBatchResult {
	inserted: number;
	failed: number;
	errors: string[];
}

// ─── Automated Backup ─────────────────────────────────────────────────────────

export type BackupProvider = 'aws-s3' | 'gcs';
export type BackupFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface BackupConfig {
	id: string;
	connectionId: string;
	name: string;
	enabled: boolean;
	provider: BackupProvider;
	frequency: BackupFrequency;
	/** UTC hour (0–23) to run the backup */
	hour: number;
	/** Day of week (0=Sun … 6=Sat) — weekly only */
	dayOfWeek?: number;
	/** Day of month (1–31) — monthly only */
	dayOfMonth?: number;
	bucket: string;
	prefix: string;
	// AWS S3
	awsRegion?: string;
	awsAccessKeyId?: string;
	/** Encrypted at rest */
	awsSecretAccessKey?: string;
	// GCS
	gcsProjectId?: string;
	gcsClientEmail?: string;
	/** Encrypted at rest (PEM private key) */
	gcsPrivateKey?: string;
	/** How many days to keep backup run records */
	retentionDays: number;
	lastRunAt?: string;
	lastRunSuccess?: boolean;
	lastRunError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface BackupRun {
	id: string;
	configId: string;
	connectionId: string;
	connectionName: string;
	startedAt: string;
	completedAt?: string;
	success: boolean;
	/** File size in bytes */
	fileSize?: number;
	/** Full storage path (e.g. s3://bucket/prefix/file.sql.gz) */
	storagePath?: string;
	error?: string;
}
