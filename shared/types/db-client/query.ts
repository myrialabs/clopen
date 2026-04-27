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
}

export type DbClientSchemaNodeType =
	| 'database'
	| 'schema'
	| 'table'
	| 'view'
	| 'collection'
	| 'index'
	| 'key'
	| 'column';

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
}

