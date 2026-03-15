/**
 * Database Diff Types
 * Shared types for schema comparison and migration script generation.
 */

import type { DBColumn } from './db-manager';

export type DiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

/** Index information introspected from a database table */
export interface DBIndexInfo {
	name: string;
	columns: string[];
	unique: boolean;
	primary: boolean;
}

/** Column-level diff between source and target */
export interface DBColumnDiff {
	name: string;
	status: DiffStatus;
	source: DBColumn | null;
	target: DBColumn | null;
}

/** Index-level diff between source and target */
export interface DBIndexDiff {
	name: string;
	status: DiffStatus;
	source: DBIndexInfo | null;
	target: DBIndexInfo | null;
}

/** Table-level diff: columns + indexes */
export interface DBTableDiff {
	tableName: string;
	schema?: string;
	status: DiffStatus;
	columns: DBColumnDiff[];
	indexes: DBIndexDiff[];
}

/** Full schema comparison result */
export interface DBSchemaDiff {
	sourceConnectionId: string;
	targetConnectionId: string;
	sourceConnectionName: string;
	targetConnectionName: string;
	tables: DBTableDiff[];
	hasDifferences: boolean;
	summary: {
		tablesAdded: number;
		tablesRemoved: number;
		tablesModified: number;
		columnsAdded: number;
		columnsRemoved: number;
		columnsModified: number;
		indexesAdded: number;
		indexesRemoved: number;
	};
}

/** Generated SQL migration scripts (UP to sync, DOWN to rollback) */
export interface DBMigrationScript {
	up: string;
	down: string;
	warnings: string[];
}
