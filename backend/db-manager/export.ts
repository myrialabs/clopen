/**
 * Database Manager Export Utilities
 * Provides helpers for batch-fetching rows and generating SQL dumps.
 */

import type { DBConnectionConfig } from '$shared/types/db-manager';
import { describeTable, executeQuery } from './index';

// ─── SQL helpers (mirrored from index.ts to avoid circular deps) ──────────────

function qIdent(name: string, type: string): string {
	if (type === 'mysql' || type === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
	if (type === 'mssql') return `[${name.replace(/\]/g, ']]')}]`;
	return `"${name.replace(/"/g, '""')}"`;
}

function tableRef(tableName: string, schema: string | undefined, type: string): string {
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

// ─── Export helpers ───────────────────────────────────────────────────────────

/**
 * Generate a CREATE TABLE statement for use in SQL dump exports.
 * For SQLite, reads directly from sqlite_master.
 * For other SQL DBs, reconstructs from column metadata.
 */
export async function generateCreateTableSql(
	config: DBConnectionConfig,
	tableName: string,
	schema?: string
): Promise<string> {
	if (config.type === 'sqlite') {
		const escaped = tableName.replace(/'/g, "''");
		const result = await executeQuery(
			config,
			`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escaped}' LIMIT 1`
		);
		const sql = result.rows[0]?.['sql'];
		if (typeof sql === 'string') {
			return `${sql};\n`;
		}
	}

	// Reconstruct from column metadata for non-SQLite databases
	const columns = await describeTable(config, tableName, schema);
	const ref = tableRef(tableName, schema, config.type);

	const colDefs = columns.map((col) => {
		let def = `  ${qIdent(col.name, config.type)} ${col.type}`;
		if (col.primaryKey) def += ' PRIMARY KEY';
		if (!col.nullable) def += ' NOT NULL';
		if (col.defaultValue !== null && col.defaultValue !== undefined) {
			def += ` DEFAULT ${col.defaultValue}`;
		}
		return def;
	});

	return `CREATE TABLE IF NOT EXISTS ${ref} (\n${colDefs.join(',\n')}\n);\n`;
}

/**
 * Convert an array of row objects into SQL INSERT statements.
 */
export function rowsToInsertSql(
	rows: Record<string, unknown>[],
	tableName: string,
	schema: string | undefined,
	dbType: string
): string {
	if (!rows.length) return '';
	const ref = tableRef(tableName, schema, dbType);
	const columns = Object.keys(rows[0]);
	const colList = columns.map((c) => qIdent(c, dbType)).join(', ');

	return (
		rows
			.map((row) => {
				const valList = columns.map((c) => formatSqlValue(row[c])).join(', ');
				return `INSERT INTO ${ref} (${colList}) VALUES (${valList});`;
			})
			.join('\n') + '\n'
	);
}

/**
 * Convert rows to CSV lines.
 * @param rows       Data rows
 * @param columns    Column names (in order)
 * @param firstBatch Whether to include the header row
 */
export function rowsToCsv(
	rows: Record<string, unknown>[],
	columns: string[],
	firstBatch: boolean
): string {
	const escapeCsv = (v: unknown): string => {
		if (v === null || v === undefined) return '';
		const s = String(v);
		if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
			return `"${s.replace(/"/g, '""')}"`;
		}
		return s;
	};

	const lines: string[] = [];
	if (firstBatch) lines.push(columns.join(','));
	for (const row of rows) {
		lines.push(columns.map((c) => escapeCsv(row[c])).join(','));
	}
	return lines.join('\n');
}

/**
 * Batch-fetch all rows for a table using pagination.
 * Returns total count alongside each batch.
 */
export async function fetchExportBatch(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	offset: number,
	batchSize: number
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
	const ref = tableRef(tableName, schema, config.type);
	let sql: string;
	if (config.type === 'mssql') {
		sql = `SELECT * FROM ${ref} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${batchSize} ROWS ONLY`;
	} else if (config.type === 'mongodb' || config.type === 'redis') {
		// Use the adapter's getTableData which handles MongoDB/Redis natively
		const { getTableData } = await import('./index');
		const result = await getTableData(config, tableName, schema, batchSize, offset);
		return { rows: result.rows, total: result.totalCount ?? result.rowCount };
	} else {
		sql = `SELECT * FROM ${ref} LIMIT ${batchSize} OFFSET ${offset}`;
	}

	const [dataResult, countResult] = await Promise.all([
		executeQuery(config, sql),
		executeQuery(config, `SELECT COUNT(*) as cnt FROM ${ref}`)
	]);

	const countRow = countResult.rows[0];
	const total = countRow
		? parseInt(String(countRow['cnt'] ?? countRow['count'] ?? countRow['COUNT(*)'] ?? Object.values(countRow)[0]), 10) || 0
		: 0;

	return { rows: dataResult.rows, total };
}

/**
 * Import a batch of rows using column mappings, within a transaction (SQL DBs).
 * Returns counts of inserted and failed rows.
 */
export async function importBatch(
	config: DBConnectionConfig,
	tableName: string,
	schema: string | undefined,
	sourceRows: Record<string, unknown>[],
	mappings: Array<{ sourceColumn: string; targetColumn: string | null }>,
	skipErrors: boolean
): Promise<{ inserted: number; failed: number; errors: string[] }> {
	const { insertRow } = await import('./index');

	const activeMappings = mappings.filter((m) => m.targetColumn !== null);
	if (!activeMappings.length) {
		return { inserted: 0, failed: sourceRows.length, errors: ['No column mappings configured'] };
	}

	let inserted = 0;
	let failed = 0;
	const errors: string[] = [];

	for (const sourceRow of sourceRows) {
		const targetRow: Record<string, unknown> = {};
		for (const m of activeMappings) {
			targetRow[m.targetColumn!] = sourceRow[m.sourceColumn] ?? null;
		}

		try {
			const result = await insertRow(config, tableName, schema, targetRow);
			if (result.error) {
				failed++;
				if (errors.length < 20) errors.push(result.error);
				if (!skipErrors) break;
			} else {
				inserted++;
			}
		} catch (err) {
			failed++;
			const msg = err instanceof Error ? err.message : 'Unknown error';
			if (errors.length < 20) errors.push(msg);
			if (!skipErrors) break;
		}
	}

	return { inserted, failed, errors };
}
