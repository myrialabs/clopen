/**
 * PostgreSQL Adapter for Database Manager
 * Uses Bun's native SQL client (Bun >= 1.1.0).
 */

import type {
	DBTable,
	DBColumn,
	DBQueryResult,
	DBConnectionConfig,
	DBConnectionTestResult
} from '$shared/types/db-manager';
import type { ForeignKeyDef } from '$shared/types/alter-table';
import { debug } from '$shared/utils/logger';

function buildUrl(config: DBConnectionConfig): string {
	const host = config.host || 'localhost';
	const port = config.port || 5432;
	const database = config.database || 'postgres';
	const user = config.username ? encodeURIComponent(config.username) : '';
	const pass = config.password ? `:${encodeURIComponent(config.password)}` : '';
	const auth = user ? `${user}${pass}@` : '';
	return `postgres://${auth}${host}:${port}/${database}`;
}

async function createClient(config: DBConnectionConfig): Promise<{ client: any; end: () => Promise<void> }> {
	// Bun.sql is available in Bun >= 1.1.0 as import { SQL } from "bun"
	const bun = await import('bun') as any;
	if (!bun.SQL) {
		throw new Error('PostgreSQL support requires Bun 1.1.0 or later');
	}
	const client = new bun.SQL({ url: buildUrl(config), max: 1 });
	return { client, end: () => client.end() };
}

export class PostgreSQLAdapter {
	private config: DBConnectionConfig;

	constructor(config: DBConnectionConfig) {
		this.config = config;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		let end: (() => Promise<void>) | null = null;
		try {
			const { client, end: closeConn } = await createClient(this.config);
			end = closeConn;
			const rows = await client.unsafe('SELECT version()');
			const version = (rows[0]?.version as string)?.split(' ').slice(0, 2).join(' ');
			return {
				success: true,
				message: 'Connected successfully',
				version,
				latencyMs: Date.now() - start
			};
		} catch (error) {
			debug.error('database', 'PostgreSQL connection test failed:', error);
			return {
				success: false,
				message: error instanceof Error ? error.message : 'Failed to connect'
			};
		} finally {
			await end?.();
		}
	}

	async listTables(): Promise<DBTable[]> {
		const { client, end } = await createClient(this.config);
		try {
			const rows = await client.unsafe(
				`SELECT table_name as name, table_type as ttype, table_schema as schema
				FROM information_schema.tables
				WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
				ORDER BY table_schema, table_name`
			);
			return rows.map((r: any) => ({
				name: r.name,
				schema: r.schema,
				type: (r.ttype === 'VIEW' ? 'view' : 'table') as 'table' | 'view'
			}));
		} finally {
			await end();
		}
	}

	async describeTable(tableName: string, schema = 'public'): Promise<DBColumn[]> {
		const { client, end } = await createClient(this.config);
		try {
			const rows = await client.unsafe(
				`SELECT
					c.column_name as name,
					c.data_type as type,
					c.is_nullable = 'YES' as nullable,
					c.column_default as default_value,
					EXISTS (
						SELECT 1 FROM information_schema.table_constraints tc
						JOIN information_schema.key_column_usage kcu
							ON tc.constraint_name = kcu.constraint_name
							AND tc.table_schema = kcu.table_schema
						WHERE tc.constraint_type = 'PRIMARY KEY'
							AND tc.table_name = $1
							AND tc.table_schema = $2
							AND kcu.column_name = c.column_name
					) as primary_key
				FROM information_schema.columns c
				WHERE c.table_name = $1 AND c.table_schema = $2
				ORDER BY c.ordinal_position`,
				[tableName, schema]
			);
			return rows.map((c: any) => ({
				name: c.name,
				type: c.type,
				nullable: c.nullable === true || c.nullable === 'true',
				primaryKey: c.primary_key === true || c.primary_key === 't',
				defaultValue: c.default_value ?? null
			}));
		} finally {
			await end();
		}
	}

	async executeQuery(sql: string): Promise<DBQueryResult> {
		const { client, end } = await createClient(this.config);
		const start = Date.now();
		try {
			const rows = await client.unsafe(sql);
			const executionTimeMs = Date.now() - start;
			const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
			return { columns, rows, rowCount: rows.length, executionTimeMs };
		} catch (error) {
			debug.error('database', 'PostgreSQL query error:', error);
			return {
				columns: [],
				rows: [],
				rowCount: 0,
				executionTimeMs: Date.now() - start,
				error: error instanceof Error ? error.message : 'Query failed'
			};
		} finally {
			await end();
		}
	}

	async getForeignKeys(tableName: string, schema = 'public'): Promise<ForeignKeyDef[]> {
		const { client, end } = await createClient(this.config);
		try {
			const rows = await client.unsafe(
				`SELECT
					kcu.column_name AS from_col,
					ccu.table_name AS to_table,
					ccu.column_name AS to_col,
					rc.delete_rule AS on_delete,
					rc.update_rule AS on_update,
					tc.constraint_name
				FROM information_schema.table_constraints tc
				JOIN information_schema.key_column_usage kcu
					ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
				JOIN information_schema.referential_constraints rc
					ON tc.constraint_name = rc.constraint_name
				JOIN information_schema.constraint_column_usage ccu
					ON rc.unique_constraint_name = ccu.constraint_name
				WHERE tc.constraint_type = 'FOREIGN KEY'
					AND tc.table_name = $1 AND tc.table_schema = $2`,
				[tableName, schema]
			);
			return rows.map((r: any) => ({
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
			await end();
		}
	}

	async getTableData(tableName: string, schema = 'public', limit = 100, offset = 0): Promise<DBQueryResult> {
		const safeTable = tableName.replace(/"/g, '""');
		const safeSchema = schema.replace(/"/g, '""');
		return this.executeQuery(
			`SELECT * FROM "${safeSchema}"."${safeTable}" LIMIT ${limit} OFFSET ${offset}`
		);
	}
}
