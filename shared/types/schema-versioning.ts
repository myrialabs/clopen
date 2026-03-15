/**
 * Schema Versioning Types
 * Tracks every ALTER TABLE applied through the UI with up/down SQL for rollback.
 */

import type { AlterChange, DBColumnDef } from './alter-table';

// ─── Core version record ──────────────────────────────────────────────────────

export interface SchemaVersion {
	id: string;
	connectionId: string;
	connectionName: string;
	connectionType: string;
	tableName: string;
	schemaName: string | null;
	versionNumber: number;
	label: string | null;
	/** SQL statements to apply this change (forward migration) */
	upStatements: string[];
	/** SQL statements to revert this change (rollback) */
	downStatements: string[];
	/** The AlterChange objects that produced this version */
	changes: AlterChange[];
	/** Column state BEFORE this version was applied */
	columnsBefore: DBColumnDef[];
	/** Column state AFTER this version was applied */
	columnsAfter: DBColumnDef[];
	appliedById: string;
	appliedByName: string;
	appliedAt: string;
	status: 'applied' | 'rolled_back';
	notes: string | null;
}

// ─── Summary (list view, no large JSON blobs) ─────────────────────────────────

export interface SchemaVersionSummary {
	id: string;
	connectionId: string;
	connectionName: string;
	connectionType: string;
	tableName: string;
	schemaName: string | null;
	versionNumber: number;
	label: string | null;
	changesCount: number;
	appliedByName: string;
	appliedAt: string;
	status: 'applied' | 'rolled_back';
}

// ─── Column-level diff (for the diff view) ───────────────────────────────────

export type ColumnDiffStatus = 'added' | 'removed' | 'modified' | 'unchanged';

export interface ColumnVersionDiff {
	name: string;
	status: ColumnDiffStatus;
	before: DBColumnDef | null;
	after: DBColumnDef | null;
}

export interface SchemaVersionDiff {
	versionIdA: string;
	versionIdB: string;
	labelA: string;
	labelB: string;
	columns: ColumnVersionDiff[];
	hasChanges: boolean;
}

// ─── Input type (for internal DB insert) ─────────────────────────────────────

export interface SchemaVersionCreateInput {
	id: string;
	connectionId: string;
	connectionName: string;
	connectionType: string;
	tableName: string;
	schemaName: string | undefined;
	versionNumber: number;
	label?: string;
	upStatements: string[];
	downStatements: string[];
	changes: AlterChange[];
	columnsBefore: DBColumnDef[];
	columnsAfter: DBColumnDef[];
	appliedById: string;
	appliedByName: string;
	appliedAt: string;
	notes?: string;
}
