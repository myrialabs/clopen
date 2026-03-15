/**
 * Table Architect Types
 * Shared types for ALTER TABLE visual operations.
 */

import type { DBType } from './db-manager';

// ─── Column definition (richer than DBColumn) ────────────────────────────────

export interface ForeignKeyDef {
	/** Column in the source table that holds this FK reference */
	fromColumn?: string;
	table: string;
	column: string;
	onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
	onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
	/** Constraint name in DB (if known) */
	constraintName?: string;
}

export interface DBColumnDef {
	name: string;
	type: string;
	nullable: boolean;
	primaryKey: boolean;
	unique: boolean;
	defaultValue?: string | null;
	foreignKey?: ForeignKeyDef | null;
}

// ─── Alter changes ────────────────────────────────────────────────────────────

export type AlterChangeType = 'add' | 'drop' | 'rename' | 'modify';

export interface AlterChange {
	/** Unique client-side ID for tracking */
	id: string;
	type: AlterChangeType;
	/** Original column name (used for drop/rename/modify) */
	columnName: string;
	/** New name — for rename */
	newName?: string;
	/** Full new definition — for add/modify */
	newDef?: DBColumnDef;
}

// ─── Preview result ───────────────────────────────────────────────────────────

export interface AlterWarning {
	severity: 'error' | 'warning';
	changeId: string;
	message: string;
}

export interface AlterPreview {
	statements: string[];
	warnings: AlterWarning[];
	requiresRecreate: boolean;
	transactional: boolean;
	/** Whether any error-level warnings exist (blocking apply) */
	hasErrors: boolean;
}

// ─── DB type selector ─────────────────────────────────────────────────────────

export interface TypeGroup {
	label: string;
	types: string[];
}

export const DB_TYPE_GROUPS: Record<DBType, TypeGroup[]> = {
	sqlite: [
		{ label: 'Numeric', types: ['INTEGER', 'REAL', 'NUMERIC'] },
		{ label: 'Text', types: ['TEXT'] },
		{ label: 'Binary', types: ['BLOB'] }
	],
	postgresql: [
		{ label: 'Integer', types: ['SMALLINT', 'INTEGER', 'BIGINT', 'SERIAL', 'BIGSERIAL'] },
		{ label: 'Decimal', types: ['DECIMAL(p,s)', 'NUMERIC(p,s)', 'REAL', 'DOUBLE PRECISION'] },
		{ label: 'Text', types: ['TEXT', 'VARCHAR(n)', 'CHAR(n)'] },
		{ label: 'Date/Time', types: ['DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ'] },
		{ label: 'Boolean', types: ['BOOLEAN'] },
		{ label: 'JSON', types: ['JSON', 'JSONB'] },
		{ label: 'Other', types: ['UUID', 'BYTEA'] }
	],
	mysql: [
		{ label: 'Integer', types: ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT'] },
		{ label: 'Decimal', types: ['DECIMAL(p,s)', 'FLOAT', 'DOUBLE'] },
		{ label: 'Text', types: ['VARCHAR(n)', 'CHAR(n)', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'] },
		{ label: 'Date/Time', types: ['DATE', 'TIME', 'DATETIME', 'TIMESTAMP', 'YEAR'] },
		{ label: 'Other', types: ['BOOLEAN', 'JSON', 'BLOB'] }
	],
	mariadb: [
		{ label: 'Integer', types: ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT'] },
		{ label: 'Decimal', types: ['DECIMAL(p,s)', 'FLOAT', 'DOUBLE'] },
		{ label: 'Text', types: ['VARCHAR(n)', 'CHAR(n)', 'TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'] },
		{ label: 'Date/Time', types: ['DATE', 'TIME', 'DATETIME', 'TIMESTAMP'] },
		{ label: 'Other', types: ['BOOLEAN', 'JSON', 'BLOB'] }
	],
	mssql: [
		{ label: 'Integer', types: ['TINYINT', 'SMALLINT', 'INT', 'BIGINT'] },
		{ label: 'Decimal', types: ['DECIMAL(p,s)', 'NUMERIC(p,s)', 'FLOAT', 'REAL', 'MONEY'] },
		{ label: 'Text', types: ['NVARCHAR(n)', 'VARCHAR(n)', 'NCHAR(n)', 'CHAR(n)', 'NVARCHAR(MAX)', 'TEXT'] },
		{ label: 'Date/Time', types: ['DATE', 'TIME', 'DATETIME', 'DATETIME2', 'DATETIMEOFFSET'] },
		{ label: 'Other', types: ['BIT', 'UNIQUEIDENTIFIER', 'VARBINARY(MAX)'] }
	],
	mongodb: [],
	redis: []
};

export const FK_ACTIONS = ['NO ACTION', 'CASCADE', 'SET NULL', 'RESTRICT'] as const;

/** DB types that support ALTER TABLE DDL operations */
export const ALTER_SUPPORTED_TYPES: DBType[] = ['sqlite', 'postgresql', 'mysql', 'mariadb', 'mssql'];
