/**
 * SQLite Adapter for Database Manager
 * Uses bun:sqlite for native SQLite support.
 */

import { Database } from 'bun:sqlite';
import type {
	DBTable,
	DBColumn,
	DBQueryResult,
	DBConnectionTestResult
} from '$shared/types/db-manager';
import type { ForeignKeyDef } from '$shared/types/alter-table';
import { debug } from '$shared/utils/logger';

export class SQLiteAdapter {
	private path: string;

	constructor(path: string) {
		this.path = path;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		try {
			const db = new Database(this.path, { readonly: false, create: false });
			const result = db.query('SELECT sqlite_version() as v').get() as { v: string };
			db.close();
			return {
				success: true,
				message: 'Connected successfully',
				version: result?.v,
				latencyMs: Date.now() - start
			};
		} catch (error) {
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Failed to connect'
			};
		}
	}

	async listTables(): Promise<DBTable[]> {
		const db = new Database(this.path);
		try {
			const tables = db
				.query(
					`SELECT name, type FROM sqlite_master
					WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
					ORDER BY name`
				)
				.all() as { name: string; type: string }[];

			return tables.map((t) => ({
				name: t.name,
				type: t.type as 'table' | 'view'
			}));
		} finally {
			db.close();
		}
	}

	async describeTable(tableName: string): Promise<DBColumn[]> {
		const db = new Database(this.path);
		try {
			const cols = db
				.query(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`)
				.all() as {
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}[];

			return cols.map((c) => ({
				name: c.name,
				type: c.type || 'TEXT',
				nullable: c.notnull === 0,
				primaryKey: c.pk > 0,
				defaultValue: c.dflt_value
			}));
		} finally {
			db.close();
		}
	}

	async executeQuery(sql: string): Promise<DBQueryResult> {
		const db = new Database(this.path);
		const start = Date.now();
		try {
			const stmt = db.query(sql);
			const rows = stmt.all() as Record<string, unknown>[];
			const executionTimeMs = Date.now() - start;
			const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
			return { columns, rows, rowCount: rows.length, executionTimeMs };
		} catch (error) {
			debug.error('database', 'SQLite query error:', error);
			return {
				columns: [],
				rows: [],
				rowCount: 0,
				executionTimeMs: Date.now() - start,
				error: error instanceof Error ? error.message : 'Query failed'
			};
		} finally {
			db.close();
		}
	}

	async getTableData(tableName: string, limit = 100, offset = 0): Promise<DBQueryResult> {
		const safe = tableName.replace(/"/g, '""');
		return this.executeQuery(`SELECT * FROM "${safe}" LIMIT ${limit} OFFSET ${offset}`);
	}

	async getForeignKeys(tableName: string): Promise<ForeignKeyDef[]> {
		const db = new Database(this.path);
		try {
			const safe = tableName.replace(/"/g, '""');
			const rows = db
				.query(`PRAGMA foreign_key_list("${safe}")`)
				.all() as { table: string; from: string; to: string; on_delete: string; on_update: string }[];
			return rows.map((r) => ({
				fromColumn: r.from,
				table: r.table,
				column: r.to || 'id',
				onDelete: (r.on_delete as ForeignKeyDef['onDelete']) || undefined,
				onUpdate: (r.on_update as ForeignKeyDef['onUpdate']) || undefined
			}));
		} catch {
			return [];
		} finally {
			db.close();
		}
	}

	async getTableRowCount(tableName: string): Promise<number> {
		const db = new Database(this.path);
		try {
			const safe = tableName.replace(/"/g, '""');
			const result = db
				.query(`SELECT COUNT(*) as c FROM "${safe}"`)
				.get() as { c: number };
			return result?.c ?? 0;
		} catch {
			return 0;
		} finally {
			db.close();
		}
	}
}
