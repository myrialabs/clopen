/**
 * db-client — query result and schema introspection types.
 */

export interface DbClientQueryResult {
	columns: Array<{ name: string; type: string | null }>;
	rows: Array<Record<string, unknown>>;
	rowCount: number;
	affectedRows: number | null;
	durationMs: number;
	driverMeta: Record<string, unknown>;
	/**
	 * Present only for multi-statement (batch) executions. The top-level
	 * fields mirror the last statement that produced rows (so single-result
	 * consumers keep working), while `batch` carries the full per-statement
	 * report.
	 */
	batch?: DbClientBatchResult;
}

export type DbClientQueryClass = 'read' | 'write' | 'ddl' | 'unknown';

export type DbClientStatementStatus = 'success' | 'error' | 'skipped';

/** Outcome of a single statement within a batch execution. */
export interface DbClientStatementResult {
	index: number;
	query: string;
	queryClass: DbClientQueryClass;
	status: DbClientStatementStatus;
	/** The statement's own result set (null for errored / skipped statements). */
	result: DbClientQueryResult | null;
	error: string | null;
	durationMs: number;
}

/** Aggregate outcome of running a `;`-separated batch of statements. */
export interface DbClientBatchResult {
	statements: DbClientStatementResult[];
	totalDurationMs: number;
	/** Whether the batch ran inside a real (atomic) transaction. */
	transaction: boolean;
	/** True when every statement succeeded. */
	ok: boolean;
}

export type DbClientSchemaNodeType =
	| 'database'
	| 'schema'
	| 'table'
	| 'view'
	| 'collection'
	| 'index'
	| 'key'
	| 'column'
	| 'function'
	| 'procedure';

export interface DbClientSchemaNode {
	name: string;
	type: DbClientSchemaNodeType;
	children?: DbClientSchemaNode[];
	meta?: Record<string, unknown>;
}

export interface DbClientObjectColumn {
	name: string;
	type: string;
	nullable: boolean;
	default: string | null;
	isPrimary: boolean;
	isUnique: boolean;
}

export interface DbClientObjectIndex {
	name: string;
	columns: string[];
	unique: boolean;
	type?: string;
}

export interface DbClientObjectForeignKey {
	column: string;
	refTable: string;
	refColumn: string;
}

export interface DbClientQueryHistoryEntry {
	id: string;
	connectionId: string;
	userId: string | null;
	query: string;
	durationMs: number | null;
	rowCount: number | null;
	status: 'success' | 'error';
	error: string | null;
	executedAt: string;
}

export interface DbClientOverview {
	serverVersion: string | null;
	latencyMs: number | null;
	sizeBytes: number | null;
	tableCount: number | null;
	viewCount: number | null;
	extra: Array<{ label: string; value: string }>;
}

export interface DbClientObjectDetails {
	name: string;
	type: DbClientSchemaNodeType;
	columns?: DbClientObjectColumn[];
	indexes?: DbClientObjectIndex[];
	foreignKeys?: DbClientObjectForeignKey[];
	rowCount?: number;
	sizeBytes?: number;
	mongoFieldStats?: Array<{ field: string; types: string[]; sampleCount: number }>;
	redisTtlSeconds?: number | null;
	redisValueType?: string;
	ddl?: string;
}

