/**
 * Database Manager Service
 * Dispatches to appropriate adapter based on DB type.
 */

import type {
	DBConnectionConfig,
	DBConnectionTestResult,
	DBTable,
	DBColumn,
	DBQueryResult,
	DBRowFilter,
	DBType,
	GlobalSearchResult,
	GlobalSearchMatch
} from '$shared/types/db-manager';
import type { ForeignKeyDef, DBColumnDef } from '$shared/types/alter-table';
import type { ERDMetadata } from '$shared/types/erd';
import { SQLiteAdapter } from './sqlite-adapter';
import { PostgreSQLAdapter } from './postgres-adapter';
import { MySQLAdapter } from './mysql-adapter';
import { MongoDBAdapter } from './mongodb-adapter';
import { RedisAdapter } from './redis-adapter';
import { MSSQLAdapter } from './mssql-adapter';
import { withSSHTunnel } from './ssh-tunnel';

// ─── SQL Helpers ──────────────────────────────────────────────────────────────

function isSqlDb(type: DBType): boolean {
	return ['sqlite', 'postgresql', 'mysql', 'mariadb', 'mssql'].includes(type);
}

function qIdent(name: string, type: DBType): string {
	if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
	if (type === 'mssql') return `[${name.replace(/\]/g, ']]')}]`;
	return `"${name.replace(/"/g, '""')}"`;
}

function tableRef(tableName: string, schema: string | undefined, type: DBType): string {
	if (type === 'sqlite' || type === 'mysql' || type === 'mariadb') return qIdent(tableName, type);
	if (schema) return `${qIdent(schema, type)}.${qIdent(tableName, type)}`;
	return qIdent(tableName, type);
}

function formatSqlValue(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'boolean') return v ? '1' : '0';
	if (typeof v === 'number' || typeof v === 'bigint') return String(v);
	return `'${String(v).replace(/'/g, "''")}'`;
}

function buildWhereClause(filters: DBRowFilter[], type: DBType): string {
	if (!filters.length) return '';
	const conditions = filters.map((f) => {
		const col = qIdent(f.column, type);
		if (f.operator === 'null') return `${col} IS NULL`;
		if (f.operator === 'notnull') return `${col} IS NOT NULL`;
		const escaped = (f.value ?? '').replace(/'/g, "''");
		switch (f.operator) {
			case 'eq': return `${col} = '${escaped}'`;
			case 'neq': return `${col} != '${escaped}'`;
			case 'like': return `${col} LIKE '%${escaped}%'`;
			case 'gt': return `${col} > '${escaped}'`;
			case 'lt': return `${col} < '${escaped}'`;
			default: return `${col} = '${escaped}'`;
		}
	});
	return `WHERE ${conditions.join(' AND ')}`;
}

// ─── Adapter Factory ──────────────────────────────────────────────────────────

function getAdapter(config: DBConnectionConfig) {
	switch (config.type) {
		case 'sqlite':
			if (!config.path) throw new Error('SQLite requires a file path');
			return new SQLiteAdapter(config.path);
		case 'postgresql':
			return new PostgreSQLAdapter(config);
		case 'mysql':
		case 'mariadb':
			return new MySQLAdapter(config);
		case 'mongodb':
			return new MongoDBAdapter(config);
		case 'redis':
			return new RedisAdapter(config);
		case 'mssql':
			return new MSSQLAdapter(config);
		default:
			throw new Error(`Unsupported database type: ${(config as any).type}`);
	}
}

// ─── Read Operations ──────────────────────────────────────────────────────────

export async function testConnection(config: DBConnectionConfig): Promise<DBConnectionTestResult> {
	return withSSHTunnel(config, (c) => getAdapter(c).testConnection());
}

export async function listTables(config: DBConnectionConfig): Promise<DBTable[]> {
	return withSSHTunnel(config, (c) => getAdapter(c).listTables());
}

export async function describeTable(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<DBColumn[]> {
	return withSSHTunnel(config, (c) => (getAdapter(c) as any).describeTable(tableName, schema));
}

export async function executeQuery(
	config: DBConnectionConfig,
	sql: string,
	activeTable?: string
): Promise<DBQueryResult> {
	return withSSHTunnel(config, (c) => {
		const adapter = getAdapter(c);
		if (c.type === 'mongodb') {
			return (adapter as MongoDBAdapter).executeQuery(sql, activeTable);
		}
		return (adapter as any).executeQuery(sql);
	});
}

export async function getTableData(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string,
	limit = 100,
	offset = 0,
	filters?: DBRowFilter[]
): Promise<DBQueryResult> {
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'mongodb') {
			return (getAdapter(c) as MongoDBAdapter).getTableData(tableName, schema, limit, offset, filters);
		}
		if (c.type === 'redis') {
			return (getAdapter(c) as RedisAdapter).getTableData(tableName, schema, limit, offset);
		}
		const ref = tableRef(tableName, schema, c.type);
		const where = filters?.length ? buildWhereClause(filters, c.type) : '';
		let sql: string;
		if (c.type === 'mssql') {
			sql = `SELECT * FROM ${ref} ${where} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
		} else {
			sql = `SELECT * FROM ${ref} ${where} LIMIT ${limit} OFFSET ${offset}`;
		}
		return (getAdapter(c) as any).executeQuery(sql);
	});
}

export async function getTableRowCount(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string,
	filters?: DBRowFilter[]
): Promise<number> {
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'mongodb') {
			return (getAdapter(c) as MongoDBAdapter).getCollectionCount(tableName, filters);
		}
		if (c.type === 'redis') {
			return (getAdapter(c) as RedisAdapter).getGroupKeyCount(tableName);
		}
		const ref = tableRef(tableName, schema, c.type);
		const where = filters?.length ? buildWhereClause(filters, c.type) : '';
		const sql = `SELECT COUNT(*) as cnt FROM ${ref} ${where}`;
		const result = await (getAdapter(c) as any).executeQuery(sql);
		if (result.error) return 0;
		const row = result.rows[0];
		if (!row) return 0;
		const val = row['cnt'] ?? row['count'] ?? row['COUNT(*)'] ?? Object.values(row)[0];
		return typeof val === 'number' ? val : parseInt(String(val), 10) || 0;
	});
}

// ─── Write Operations ─────────────────────────────────────────────────────────

export async function insertRow(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	data: Record<string, unknown>
): Promise<DBQueryResult> {
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'mongodb') return (getAdapter(c) as MongoDBAdapter).insertDocument(tableName, data);
		if (c.type === 'redis') throw new Error('Write operations are not supported for Redis in Browse mode. Use the Query tab.');
		if (!isSqlDb(c.type)) throw new Error(`Insert not supported for ${c.type}`);
		const ref = tableRef(tableName, schema, c.type);
		const cols = Object.keys(data);
		if (!cols.length) throw new Error('No data provided for insert');
		const colList = cols.map((col) => qIdent(col, c.type)).join(', ');
		const valList = cols.map((col) => formatSqlValue(data[col])).join(', ');
		return (getAdapter(c) as any).executeQuery(`INSERT INTO ${ref} (${colList}) VALUES (${valList})`);
	});
}

export async function updateRow(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	pkColumn: string,
	pkValue: unknown,
	data: Record<string, unknown>
): Promise<DBQueryResult> {
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'mongodb') return (getAdapter(c) as MongoDBAdapter).updateDocument(tableName, String(pkValue), data);
		if (c.type === 'redis') throw new Error('Write operations are not supported for Redis in Browse mode. Use the Query tab.');
		if (!isSqlDb(c.type)) throw new Error(`Update not supported for ${c.type}`);
		const ref = tableRef(tableName, schema, c.type);
		const setCols = Object.keys(data).filter((col) => col !== pkColumn);
		if (!setCols.length) throw new Error('No columns to update');
		const setClause = setCols.map((col) => `${qIdent(col, c.type)} = ${formatSqlValue(data[col])}`).join(', ');
		return (getAdapter(c) as any).executeQuery(
			`UPDATE ${ref} SET ${setClause} WHERE ${qIdent(pkColumn, c.type)} = ${formatSqlValue(pkValue)}`
		);
	});
}

export async function deleteRows(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	pkColumn: string,
	pkValues: unknown[]
): Promise<DBQueryResult> {
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'mongodb') return (getAdapter(c) as MongoDBAdapter).deleteDocuments(tableName, pkValues.map(String));
		if (c.type === 'redis') throw new Error('Write operations are not supported for Redis in Browse mode. Use the Query tab.');
		if (!isSqlDb(c.type)) throw new Error(`Delete not supported for ${c.type}`);
		const ref = tableRef(tableName, schema, c.type);
		const inList = pkValues.map(formatSqlValue).join(', ');
		return (getAdapter(c) as any).executeQuery(`DELETE FROM ${ref} WHERE ${qIdent(pkColumn, c.type)} IN (${inList})`);
	});
}

// ─── Bulk Write Operations ────────────────────────────────────────────────────

/**
 * Bulk-delete rows in a single SQL transaction.
 * - filter mode: DELETE FROM table WHERE <filters>   (entire filter-matched dataset)
 * - pks mode:    DELETE FROM table WHERE pk IN (...)  (explicit PK list)
 *
 * SQLite: wraps in explicit BEGIN…COMMIT via bun:sqlite.
 * Other SQL: relies on the implicit per-statement transaction.
 */
export async function bulkDeleteRows(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	options:
		| { mode: 'filter'; filters: DBRowFilter[] }
		| { mode: 'pks'; pkColumn: string; pkValues: unknown[] }
): Promise<{ affectedRows: number; executionTimeMs: number; error?: string }> {
	const start = Date.now();

	try {
		return await withSSHTunnel(config, async (c) => {
			if (!isSqlDb(c.type)) throw new Error(`Bulk delete not supported for ${c.type}`);
			const ref = tableRef(tableName, schema, c.type);

			if (c.type === 'sqlite') {
				const { Database } = await import('bun:sqlite');
				const db = new Database(c.path!);
				try {
					db.run('BEGIN');
					let affected = 0;
					try {
						if (options.mode === 'filter') {
							const where = options.filters.length ? buildWhereClause(options.filters, c.type) : '';
							db.run(`DELETE FROM ${ref} ${where}`);
							const row = db.query('SELECT changes() AS c').get() as { c: number } | null;
							affected = row?.c ?? 0;
						} else {
							const pkCol = qIdent(options.pkColumn, c.type);
							const inList = options.pkValues.map(formatSqlValue).join(', ');
							db.run(`DELETE FROM ${ref} WHERE ${pkCol} IN (${inList})`);
							const row = db.query('SELECT changes() AS c').get() as { c: number } | null;
							affected = row?.c ?? options.pkValues.length;
						}
						db.run('COMMIT');
					} catch (err) {
						db.run('ROLLBACK');
						throw err;
					}
					return { affectedRows: affected, executionTimeMs: Date.now() - start };
				} finally {
					db.close();
				}
			}

			// Non-SQLite: single-statement atomic DELETE
			let sql: string;
			if (options.mode === 'filter') {
				const where = options.filters.length ? buildWhereClause(options.filters, c.type) : '';
				sql = `DELETE FROM ${ref} ${where}`;
			} else {
				const pkCol = qIdent(options.pkColumn, c.type);
				const inList = options.pkValues.map(formatSqlValue).join(', ');
				sql = `DELETE FROM ${ref} WHERE ${pkCol} IN (${inList})`;
			}
			const result = await (getAdapter(c) as any).executeQuery(sql);
			if (result.error) throw new Error(result.error);
			return {
				affectedRows: result.affectedRows ?? (options.mode === 'pks' ? options.pkValues.length : 0),
				executionTimeMs: Date.now() - start
			};
		});
	} catch (err) {
		return {
			affectedRows: 0,
			executionTimeMs: Date.now() - start,
			error: err instanceof Error ? err.message : 'Bulk delete failed'
		};
	}
}

/**
 * Bulk-update a single column in a single SQL transaction.
 * - filter mode: UPDATE table SET col = val WHERE <filters>
 * - pks mode:    UPDATE table SET col = val WHERE pk IN (...)
 *
 * SQLite: wraps in explicit BEGIN…COMMIT via bun:sqlite.
 * Other SQL: relies on the implicit per-statement transaction.
 */
export async function bulkUpdateRows(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	column: string,
	value: unknown,
	options:
		| { mode: 'filter'; filters: DBRowFilter[] }
		| { mode: 'pks'; pkColumn: string; pkValues: unknown[] }
): Promise<{ affectedRows: number; executionTimeMs: number; error?: string }> {
	const start = Date.now();

	try {
		return await withSSHTunnel(config, async (c) => {
			if (!isSqlDb(c.type)) throw new Error(`Bulk update not supported for ${c.type}`);
			const ref = tableRef(tableName, schema, c.type);
			const colEsc = qIdent(column, c.type);
			const valSql = formatSqlValue(value);
			const setClause = `${colEsc} = ${valSql}`;

			if (c.type === 'sqlite') {
				const { Database } = await import('bun:sqlite');
				const db = new Database(c.path!);
				try {
					db.run('BEGIN');
					let affected = 0;
					try {
						if (options.mode === 'filter') {
							const where = options.filters.length ? buildWhereClause(options.filters, c.type) : '';
							db.run(`UPDATE ${ref} SET ${setClause} ${where}`);
							const row = db.query('SELECT changes() AS c').get() as { c: number } | null;
							affected = row?.c ?? 0;
						} else {
							const pkCol = qIdent(options.pkColumn, c.type);
							const inList = options.pkValues.map(formatSqlValue).join(', ');
							db.run(`UPDATE ${ref} SET ${setClause} WHERE ${pkCol} IN (${inList})`);
							const row = db.query('SELECT changes() AS c').get() as { c: number } | null;
							affected = row?.c ?? options.pkValues.length;
						}
						db.run('COMMIT');
					} catch (err) {
						db.run('ROLLBACK');
						throw err;
					}
					return { affectedRows: affected, executionTimeMs: Date.now() - start };
				} finally {
					db.close();
				}
			}

			// Non-SQLite: single-statement atomic UPDATE
			let sql: string;
			if (options.mode === 'filter') {
				const where = options.filters.length ? buildWhereClause(options.filters, c.type) : '';
				sql = `UPDATE ${ref} SET ${setClause} ${where}`;
			} else {
				const pkCol = qIdent(options.pkColumn, c.type);
				const inList = options.pkValues.map(formatSqlValue).join(', ');
				sql = `UPDATE ${ref} SET ${setClause} WHERE ${pkCol} IN (${inList})`;
			}
			const result = await (getAdapter(c) as any).executeQuery(sql);
			if (result.error) throw new Error(result.error);
			return {
				affectedRows: result.affectedRows ?? (options.mode === 'pks' ? options.pkValues.length : 0),
				executionTimeMs: Date.now() - start
			};
		});
	} catch (err) {
		return {
			affectedRows: 0,
			executionTimeMs: Date.now() - start,
			error: err instanceof Error ? err.message : 'Bulk update failed'
		};
	}
}

// ─── Schema / Alter Table Operations ──────────────────────────────────────────

export async function getForeignKeys(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<ForeignKeyDef[]> {
	return withSSHTunnel(config, (c) => (getAdapter(c) as any).getForeignKeys(tableName, schema));
}

export async function describeTableWithFks(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<DBColumnDef[]> {
	const [columns, fks] = await Promise.all([
		describeTable(config, tableName, schema),
		getForeignKeys(config, tableName, schema)
	]);
	const fkMap = new Map<string, ForeignKeyDef>();
	for (const fk of fks) {
		if (fk.fromColumn) fkMap.set(fk.fromColumn, fk);
	}
	return columns.map((col) => ({
		...col,
		unique: col.unique ?? false,
		foreignKey: fkMap.get(col.name) ?? null
	}));
}

// ─── ERD Metadata ─────────────────────────────────────────────────────────────

export async function getERDMetadata(config: DBConnectionConfig): Promise<ERDMetadata> {
	const allTables = await listTables(config);
	const sqlTables = allTables.filter((t) => t.type === 'table');

	const results = await Promise.all(
		sqlTables.map(async (table) => {
			const [columns, fks] = await Promise.all([
				describeTable(config, table.name, table.schema),
				getForeignKeys(config, table.name, table.schema)
			]);
			const fkColSet = new Set(fks.map((fk) => fk.fromColumn).filter(Boolean));
			const tableMeta = {
				name: table.name,
				schema: table.schema,
				columns: columns.map((col) => ({
					name: col.name,
					type: col.type,
					isPrimary: col.primaryKey,
					isForeign: fkColSet.has(col.name)
				}))
			};
			const rels = fks
				.filter((fk) => fk.fromColumn)
				.map((fk) => ({
					fromTable: table.name,
					fromColumn: fk.fromColumn!,
					toTable: fk.table,
					toColumn: fk.column,
					constraintName: fk.constraintName
				}));
			return { tableMeta, rels };
		})
	);

	return {
		tables: results.map((r) => r.tableMeta),
		relationships: results.flatMap((r) => r.rels)
	};
}

// ─── Audit Trail Helpers ──────────────────────────────────────────────────────

/**
 * Fetch a snapshot of rows identified by their PK values BEFORE a write
 * operation, for use in audit trail before/after diff.
 */
export async function fetchRowSnapshot(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	pkColumn: string,
	pkValues: unknown[]
): Promise<Record<string, unknown>[]> {
	if (!pkValues.length || !isSqlDb(config.type)) return [];
	return withSSHTunnel(config, async (c) => {
		const ref = tableRef(tableName, schema, c.type);
		const colEsc = qIdent(pkColumn, c.type);
		let sql: string;
		if (pkValues.length === 1) {
			sql = `SELECT * FROM ${ref} WHERE ${colEsc} = ${formatSqlValue(pkValues[0])}`;
		} else {
			const inList = pkValues.map(formatSqlValue).join(', ');
			sql = `SELECT * FROM ${ref} WHERE ${colEsc} IN (${inList})`;
		}
		const result = await (getAdapter(c) as any).executeQuery(sql);
		return (result.rows ?? []) as Record<string, unknown>[];
	});
}

/**
 * Generate the reverse SQL statement(s) needed to undo a logged DML operation.
 * Throws if the operation cannot be reversed with the available snapshot data.
 */
export function generateRollbackSql(params: {
	action: string;
	tableName: string;
	dbType: DBType;
	beforeData: Record<string, unknown> | Record<string, unknown>[] | null;
	pkColumn: string | null;
	pkValue: unknown;
}): string[] {
	const { action, tableName, dbType, beforeData, pkColumn, pkValue } = params;
	const ref = tableRef(tableName, undefined, dbType);

	if (action === 'data:update' && beforeData && !Array.isArray(beforeData) && pkColumn) {
		const row = beforeData as Record<string, unknown>;
		const setCols = Object.keys(row).filter((c) => c !== pkColumn);
		if (!setCols.length) throw new Error('No columns to restore');
		const setClause = setCols
			.map((c) => `${qIdent(c, dbType)} = ${formatSqlValue(row[c])}`)
			.join(', ');
		return [
			`UPDATE ${ref} SET ${setClause} WHERE ${qIdent(pkColumn, dbType)} = ${formatSqlValue(pkValue)}`
		];
	}

	if (action === 'data:delete' && beforeData) {
		const rows = Array.isArray(beforeData) ? beforeData : [beforeData];
		return rows.map((row) => {
			const cols = Object.keys(row);
			const colList = cols.map((c) => qIdent(c, dbType)).join(', ');
			const valList = cols.map((c) => formatSqlValue(row[c])).join(', ');
			return `INSERT INTO ${ref} (${colList}) VALUES (${valList})`;
		});
	}

	if (action === 'data:insert' && pkColumn && pkValue !== null && pkValue !== undefined) {
		return [
			`DELETE FROM ${ref} WHERE ${qIdent(pkColumn, dbType)} = ${formatSqlValue(pkValue)}`
		];
	}

	throw new Error(
		`Cannot generate rollback SQL for action "${action}" — missing required snapshot data`
	);
}

// ─── Global Search ─────────────────────────────────────────────────────────────

/** Column type patterns considered "text-searchable" across all supported SQL engines */
const TEXT_TYPE_RE = /\b(text|varchar|char|nchar|nvarchar|clob|string|tinytext|mediumtext|longtext|enum|name|uuid|json|jsonb|citext|xml)\b/i;

/**
 * Native text types that support LIKE without any cast.
 * Anything else that matches TEXT_TYPE_RE needs an explicit CAST to avoid
 * operator errors (e.g. PostgreSQL uuid ~~ unknown, json ~~ unknown).
 */
const NATIVE_TEXT_RE = /\b(text|varchar|char|nchar|nvarchar|clob|string|tinytext|mediumtext|longtext|citext)\b/i;

function isTextColumn(type: string): boolean {
	return TEXT_TYPE_RE.test(type);
}

/** Returns the SQL expression for using LIKE on `col`, adding a cast when needed. */
function likeExpr(colIdent: string, colType: string, dbType: DBType): string {
	if (NATIVE_TEXT_RE.test(colType)) return colIdent;
	// uuid, json, jsonb, name, xml, enum — need explicit text cast
	if (dbType === 'postgresql') return `${colIdent}::text`;
	if (dbType === 'mssql') return `CAST(${colIdent} AS NVARCHAR(MAX))`;
	// MySQL/MariaDB/SQLite handle these fine with CAST or implicit coercion
	return `CAST(${colIdent} AS CHAR)`;
}

/**
 * Run up to `concurrency` async tasks at a time from an array of thunks.
 */
async function pooled<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
	const results: T[] = [];
	let idx = 0;
	async function worker() {
		while (idx < tasks.length) {
			const i = idx++;
			results[i] = await tasks[i]();
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
	return results;
}

export async function globalSearch(
	config: DBConnectionConfig,
	query: string,
	options: { maxMatchesPerTable?: number; maxTotalMatches?: number } = {}
): Promise<GlobalSearchResult> {
	const { maxMatchesPerTable = 10, maxTotalMatches = 300 } = options;
	const startMs = Date.now();
	const matches: GlobalSearchMatch[] = [];
	let tablesSearched = 0;
	let columnsSearched = 0;
	let truncated = false;

	try {
		await withSSHTunnel(config, async (c) => {
			// MongoDB: use $regex across all string fields per collection
			if (c.type === 'mongodb') {
				const adapter = getAdapter(c) as MongoDBAdapter;
				const tables = await adapter.listTables();
				for (const table of tables) {
					if (matches.length >= maxTotalMatches) { truncated = true; break; }
					try {
						const result = await adapter.getTableData(table.name, undefined, maxMatchesPerTable, 0);
						tablesSearched++;
						if (result.error || !result.rows.length) continue;
						const q = query.toLowerCase();
						for (const row of result.rows) {
							if (matches.length >= maxTotalMatches) { truncated = true; break; }
							const matchedCol = Object.keys(row).find((k) => {
								const v = row[k];
								return typeof v === 'string' && v.toLowerCase().includes(q);
							});
							if (matchedCol) {
								columnsSearched++;
								matches.push({ tableName: table.name, columnName: matchedCol, row });
							}
						}
					} catch {
						// Skip table on error
					}
				}
				return;
			}

			// Redis: search key patterns
			if (c.type === 'redis') {
				try {
					const adapter = getAdapter(c) as RedisAdapter;
					const result = await adapter.getTableData('keys', undefined, 100, 0);
					tablesSearched++;
					const q = query.toLowerCase();
					for (const row of result.rows) {
						if (matches.length >= maxTotalMatches) { truncated = true; break; }
						const keyVal = String(Object.values(row)[0] ?? '');
						if (keyVal.toLowerCase().includes(q)) {
							columnsSearched++;
							matches.push({ tableName: 'keys', columnName: 'key', row });
						}
					}
				} catch {
					// Skip
				}
				return;
			}

			// SQL databases
			const tables = await getAdapter(c).listTables();
			const sqlTables = tables.filter((t) => t.type === 'table');

			const tasks = sqlTables.map((table) => async () => {
				if (matches.length >= maxTotalMatches) { truncated = true; return; }
				let cols: DBColumn[] = [];
				try {
					cols = await (getAdapter(c) as any).describeTable(table.name, table.schema);
				} catch {
					return;
				}
				const textCols = cols.filter((col) => isTextColumn(col.type));
				if (!textCols.length) return;

				tablesSearched++;
				columnsSearched += textCols.length;

				const pkCol = cols.find((col) => col.primaryKey)?.name ?? cols[0]?.name;
				const ref = tableRef(table.name, table.schema, c.type);
				const escaped = query.replace(/'/g, "''");

				const orClauses = textCols
					.map((col) => `${likeExpr(qIdent(col.name, c.type), col.type, c.type)} LIKE '%${escaped}%'`)
					.join(' OR ');

				let sql: string;
				if (c.type === 'mssql') {
					sql = `SELECT TOP ${maxMatchesPerTable} * FROM ${ref} WHERE ${orClauses}`;
				} else {
					sql = `SELECT * FROM ${ref} WHERE ${orClauses} LIMIT ${maxMatchesPerTable}`;
				}

				let result: DBQueryResult;
				try {
					result = await (getAdapter(c) as any).executeQuery(sql);
				} catch {
					return;
				}
				if (result.error || !result.rows.length) return;

				for (const row of result.rows) {
					if (matches.length >= maxTotalMatches) { truncated = true; break; }
					// Find which column(s) matched for reporting
					const q = query.toLowerCase();
					const matchedCol = textCols.find((col) => {
						const v = row[col.name];
						return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
					});
					matches.push({
						tableName: table.name,
						tableSchema: table.schema,
						columnName: matchedCol?.name ?? textCols[0].name,
						row,
						pkColumn: pkCol
					});
				}
			});

			// Process tables with concurrency limit of 4
			await pooled(tasks, 4);
		});
	} catch (error) {
		return {
			query,
			matches: [],
			tablesSearched: 0,
			columnsSearched: 0,
			executionTimeMs: Date.now() - startMs,
			truncated: false,
			error: error instanceof Error ? error.message : 'Search failed'
		};
	}

	return {
		query,
		matches,
		tablesSearched,
		columnsSearched,
		executionTimeMs: Date.now() - startMs,
		truncated
	};
}

// ─── Global Search Suggest ────────────────────────────────────────────────────

export interface GlobalSearchSuggestion {
	value: string;
	tableName: string;
	tableSchema?: string;
	columnName: string;
}

/**
 * Fetch autocomplete suggestions by doing fast DISTINCT prefix-match queries
 * on text columns. Scans up to 5 tables × 2 columns with concurrency 4.
 */
export async function globalSearchSuggest(
	config: DBConnectionConfig,
	query: string,
	options: { maxSuggestions?: number } = {}
): Promise<GlobalSearchSuggestion[]> {
	const { maxSuggestions = 15 } = options;
	if (!query.trim()) return [];

	const results: GlobalSearchSuggestion[] = [];

	try {
		await withSSHTunnel(config, async (c) => {
			if (c.type === 'mongodb' || c.type === 'redis') return;

			const tables = await getAdapter(c).listTables();
			// Limit to first 8 tables for speed; prefer tables with data
			const sqlTables = tables.filter((t) => t.type === 'table').slice(0, 8);

			const escaped = query.replace(/'/g, "''");
			const seen = new Set<string>();

			const tasks = sqlTables.map((table) => async () => {
				if (results.length >= maxSuggestions) return;
				let cols: DBColumn[] = [];
				try {
					cols = await (getAdapter(c) as any).describeTable(table.name, table.schema);
				} catch {
					return;
				}
				const textCols = cols.filter((col) => isTextColumn(col.type)).slice(0, 2);
				if (!textCols.length) return;

				const ref = tableRef(table.name, table.schema, c.type);

				for (const col of textCols) {
					if (results.length >= maxSuggestions) break;
					const colId = qIdent(col.name, c.type);
					const expr = likeExpr(colId, col.type, c.type);

					let sql: string;
					const likePattern = `'${escaped}%'`;
					if (c.type === 'mssql') {
						sql = `SELECT DISTINCT TOP 5 ${colId} AS v FROM ${ref} WHERE ${expr} LIKE ${likePattern}`;
					} else {
						// Use LOWER for case-insensitive prefix match on non-case-insensitive engines
						const lowerExpr = c.type === 'postgresql' ? `LOWER(${expr})` : expr;
						sql = `SELECT DISTINCT ${colId} AS v FROM ${ref} WHERE ${lowerExpr} LIKE LOWER(${likePattern}) LIMIT 5`;
					}

					let res: DBQueryResult;
					try {
						res = await (getAdapter(c) as any).executeQuery(sql);
					} catch {
						continue;
					}
					if (res.error || !res.rows.length) continue;

					for (const row of res.rows) {
						const raw = row['v'] ?? Object.values(row)[0];
						if (raw === null || raw === undefined) continue;
						const val = String(raw).trim();
						if (!val || seen.has(val.toLowerCase())) continue;
						seen.add(val.toLowerCase());
						results.push({
							value: val,
							tableName: table.name,
							tableSchema: table.schema,
							columnName: col.name
						});
						if (results.length >= maxSuggestions) break;
					}
				}
			});

			await pooled(tasks, 4);
		});
	} catch {
		// Return whatever we collected
	}

	return results;
}

export async function applyAlterStatements(
	config: DBConnectionConfig,
	statements: string[]
): Promise<{ ok: boolean; error?: string }> {
	if (!statements.length) return { ok: true };
	return withSSHTunnel(config, async (c) => {
		if (c.type === 'sqlite') {
			const { Database } = await import('bun:sqlite');
			const db = new Database(c.path!);
			try {
				for (const stmt of statements) {
					const s = stmt.trim();
					if (s) db.run(s);
				}
				return { ok: true };
			} catch (err) {
				return { ok: false, error: err instanceof Error ? err.message : 'Failed to apply changes' };
			} finally {
				db.close();
			}
		}
		for (const stmt of statements) {
			const result = await (getAdapter(c) as any).executeQuery(stmt);
			if (result.error) return { ok: false, error: result.error };
		}
		return { ok: true };
	});
}
