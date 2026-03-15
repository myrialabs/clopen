/**
 * MySQL / MariaDB Adapter
 * Uses mysql2/promise (Node.js-compatible, works with Bun).
 */

import type {
	DBConnectionConfig,
	DBTable,
	DBColumn,
	DBQueryResult,
	DBConnectionTestResult
} from '$shared/types/db-manager';
import type { ForeignKeyDef } from '$shared/types/alter-table';
import { debug } from '$shared/utils/logger';

async function createConn(config: DBConnectionConfig) {
	const mysql = await import('mysql2/promise');
	return mysql.createConnection({
		host: config.host || 'localhost',
		port: config.port || 3306,
		database: config.database,
		user: config.username,
		password: config.password,
		ssl: config.ssl ? {} : undefined,
		multipleStatements: false
	});
}

export class MySQLAdapter {
	private config: DBConnectionConfig;

	constructor(config: DBConnectionConfig) {
		this.config = config;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		let conn: Awaited<ReturnType<typeof createConn>> | null = null;
		try {
			conn = await createConn(this.config);
			const [rows] = await conn.query('SELECT VERSION() AS v');
			return {
				success: true,
				message: 'Connected successfully',
				version: (rows as any[])[0]?.v,
				latencyMs: Date.now() - start
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : 'Failed to connect' };
		} finally {
			await conn?.end();
		}
	}

	async listTables(): Promise<DBTable[]> {
		const conn = await createConn(this.config);
		try {
			const [rows] = await conn.query(
				`SELECT TABLE_NAME AS name, TABLE_TYPE AS ttype
				FROM information_schema.tables
				WHERE TABLE_SCHEMA = ?
				ORDER BY TABLE_NAME`,
				[this.config.database]
			);
			return (rows as any[]).map((r) => ({
				name: r.name,
				type: (r.ttype === 'VIEW' ? 'view' : 'table') as 'table' | 'view'
			}));
		} finally {
			await conn.end();
		}
	}

	async describeTable(tableName: string): Promise<DBColumn[]> {
		const conn = await createConn(this.config);
		try {
			const safe = tableName.replace(/`/g, '``');
			const [rows] = await conn.query(`SHOW COLUMNS FROM \`${safe}\``);
			return (rows as any[]).map((c) => ({
				name: c.Field,
				type: c.Type,
				nullable: c.Null === 'YES',
				primaryKey: c.Key === 'PRI',
				unique: c.Key === 'UNI',
				defaultValue: c.Default ?? null
			}));
		} finally {
			await conn.end();
		}
	}

	async executeQuery(sql: string): Promise<DBQueryResult> {
		const conn = await createConn(this.config);
		const start = Date.now();
		try {
			const [result] = await conn.query(sql);
			const executionTimeMs = Date.now() - start;

			if (Array.isArray(result)) {
				const rows = result as Record<string, unknown>[];
				return {
					columns: rows.length > 0 ? Object.keys(rows[0]) : [],
					rows,
					rowCount: rows.length,
					executionTimeMs
				};
			}
			// Non-SELECT (INSERT/UPDATE/DELETE)
			const res = result as any;
			return {
				columns: ['affectedRows', 'insertId'],
				rows: [{ affectedRows: res.affectedRows, insertId: res.insertId }],
				rowCount: res.affectedRows ?? 0,
				executionTimeMs,
				affectedRows: res.affectedRows
			};
		} catch (error) {
			debug.error('database', 'MySQL query error:', error);
			return {
				columns: [],
				rows: [],
				rowCount: 0,
				executionTimeMs: Date.now() - start,
				error: error instanceof Error ? error.message : 'Query failed'
			};
		} finally {
			await conn.end();
		}
	}

	async getForeignKeys(tableName: string): Promise<ForeignKeyDef[]> {
		const conn = await createConn(this.config);
		try {
			const [rows] = await conn.query(
				`SELECT kcu.COLUMN_NAME AS from_col, kcu.REFERENCED_TABLE_NAME AS to_table,
					kcu.REFERENCED_COLUMN_NAME AS to_col, rc.DELETE_RULE AS on_delete, rc.UPDATE_RULE AS on_update,
					kcu.CONSTRAINT_NAME AS constraint_name
				FROM information_schema.KEY_COLUMN_USAGE kcu
				JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
					ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
				WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
				[this.config.database, tableName]
			);
			return (rows as any[]).map((r) => ({
				fromColumn: r.from_col,
				table: r.to_table,
				column: r.to_col,
				onDelete: r.on_delete as ForeignKeyDef['onDelete'],
				onUpdate: r.on_update as ForeignKeyDef['onUpdate'],
				constraintName: r.constraint_name
			}));
		} catch {
			return [];
		} finally {
			await conn.end();
		}
	}

	async getTableData(tableName: string, _schema?: string, limit = 100, offset = 0): Promise<DBQueryResult> {
		const safe = tableName.replace(/`/g, '``');
		return this.executeQuery(`SELECT * FROM \`${safe}\` LIMIT ${limit} OFFSET ${offset}`);
	}
}
