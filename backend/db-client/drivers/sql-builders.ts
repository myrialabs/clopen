/**
 * Shared SQL builder helpers for MySQL / PostgreSQL / SQLite adapters.
 *
 * All builders return parameterized statements so user values are
 * never interpolated into the SQL string.
 */

import type { ColumnDefinition, IndexDefinition, TableDefinition } from './types';

const MYSQL_RESERVED_RX = /[^A-Za-z0-9_$]/;

export function quoteMysql(name: string): string {
	if (!name) throw new Error('Identifier cannot be empty');
	if (name.includes('`')) throw new Error(`Invalid identifier: ${name}`);
	return `\`${name}\``;
}

export function quotePg(name: string): string {
	if (!name) throw new Error('Identifier cannot be empty');
	if (name.includes('"')) throw new Error(`Invalid identifier: ${name}`);
	return `"${name}"`;
}

export function quoteSqlite(name: string): string {
	return quotePg(name);
}

export type Quoter = (name: string) => string;

export function qualified(quote: Quoter, parts: Array<string | undefined | null>): string {
	return parts.filter((p): p is string => Boolean(p)).map(quote).join('.');
}

interface BuildInsertInput {
	quote: Quoter;
	table: string;
	row: Record<string, unknown>;
	schema?: string;
	database?: string;
	placeholder: (i: number) => string;
}

export function buildInsert({
	quote,
	table,
	row,
	schema,
	database,
	placeholder
}: BuildInsertInput): { sql: string; params: unknown[] } {
	const cols = Object.keys(row);
	if (cols.length === 0) throw new Error('Insert requires at least one column');
	const params = cols.map((c) => row[c]);
	const fqt = qualified(quote, [database, schema, table]);
	const colSql = cols.map(quote).join(', ');
	const placeholders = cols.map((_, i) => placeholder(i)).join(', ');
	return {
		sql: `INSERT INTO ${fqt} (${colSql}) VALUES (${placeholders})`,
		params
	};
}

interface BuildUpdateInput {
	quote: Quoter;
	table: string;
	pk: Record<string, unknown>;
	changes: Record<string, unknown>;
	schema?: string;
	database?: string;
	placeholder: (i: number) => string;
}

export function buildUpdate({
	quote,
	table,
	pk,
	changes,
	schema,
	database,
	placeholder
}: BuildUpdateInput): { sql: string; params: unknown[] } {
	const setCols = Object.keys(changes);
	const pkCols = Object.keys(pk);
	if (setCols.length === 0) throw new Error('Update requires at least one change');
	if (pkCols.length === 0) throw new Error('Update requires a primary key');

	const params: unknown[] = [];
	const setSql = setCols.map((c) => {
		params.push(changes[c]);
		return `${quote(c)} = ${placeholder(params.length - 1)}`;
	}).join(', ');

	const whereSql = pkCols.map((c) => {
		params.push(pk[c]);
		return `${quote(c)} = ${placeholder(params.length - 1)}`;
	}).join(' AND ');

	const fqt = qualified(quote, [database, schema, table]);
	return {
		sql: `UPDATE ${fqt} SET ${setSql} WHERE ${whereSql}`,
		params
	};
}

interface BuildDeleteInput {
	quote: Quoter;
	table: string;
	pks: Record<string, unknown>[];
	schema?: string;
	database?: string;
	placeholder: (i: number) => string;
}

export function buildDelete({
	quote,
	table,
	pks,
	schema,
	database,
	placeholder
}: BuildDeleteInput): { sql: string; params: unknown[] } {
	if (pks.length === 0) throw new Error('Delete requires at least one row');
	const cols = Object.keys(pks[0]);
	if (cols.length === 0) throw new Error('Delete requires a primary key');

	const params: unknown[] = [];
	const groups: string[] = [];
	for (const pk of pks) {
		const conds = cols.map((c) => {
			params.push(pk[c]);
			return `${quote(c)} = ${placeholder(params.length - 1)}`;
		}).join(' AND ');
		groups.push(`(${conds})`);
	}
	const fqt = qualified(quote, [database, schema, table]);
	return {
		sql: `DELETE FROM ${fqt} WHERE ${groups.join(' OR ')}`,
		params
	};
}

interface RenderColumnInput {
	quote: Quoter;
	column: ColumnDefinition;
	driver: 'mysql' | 'postgres' | 'sqlite';
}

export function renderColumn({ quote, column, driver }: RenderColumnInput): string {
	const parts = [quote(column.name), column.type];
	if (column.nullable === false) parts.push('NOT NULL');
	if (column.default !== undefined && column.default !== null && column.default !== '') {
		parts.push(`DEFAULT ${column.default}`);
	}
	if (column.autoIncrement) {
		if (driver === 'mysql') parts.push('AUTO_INCREMENT');
		else if (driver === 'sqlite') parts.push('AUTOINCREMENT');
		// PG handled via SERIAL/IDENTITY in the type itself; nothing to append.
	}
	if (column.primary) parts.push('PRIMARY KEY');
	if (column.unique) parts.push('UNIQUE');
	return parts.join(' ');
}

interface RenderTableInput {
	quote: Quoter;
	definition: TableDefinition;
	schema?: string;
	database?: string;
	driver: 'mysql' | 'postgres' | 'sqlite';
}

export function renderCreateTable({
	quote,
	definition,
	schema,
	database,
	driver
}: RenderTableInput): string {
	if (definition.columns.length === 0) throw new Error('Table needs at least one column');
	const colSql = definition.columns.map((column) => renderColumn({ quote, column, driver }));
	const fqt = qualified(quote, [database, schema, definition.name]);
	if (definition.primaryKey && definition.primaryKey.length > 0) {
		colSql.push(`PRIMARY KEY (${definition.primaryKey.map(quote).join(', ')})`);
	}
	return `CREATE TABLE ${fqt} (${colSql.join(', ')})`;
}

interface RenderIndexInput {
	quote: Quoter;
	tableName: string;
	def: IndexDefinition;
	schema?: string;
	database?: string;
}

export function renderCreateIndex({
	quote,
	tableName,
	def,
	schema,
	database
}: RenderIndexInput): string {
	if (def.columns.length === 0) throw new Error('Index needs at least one column');
	const fqt = qualified(quote, [database, schema, tableName]);
	const cols = def.columns.map(quote).join(', ');
	const unique = def.unique ? 'UNIQUE ' : '';
	return `CREATE ${unique}INDEX ${quote(def.name)} ON ${fqt} (${cols})`;
}

/** Validate identifier shape — defense-in-depth before quoting. */
export function assertSafeIdentifier(name: string): void {
	if (!name || MYSQL_RESERVED_RX.test(name)) {
		throw new Error(`Invalid identifier: ${name}`);
	}
}
