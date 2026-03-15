/**
 * Microsoft SQL Server Adapter
 * Uses the `mssql` package.
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

async function createPool(config: DBConnectionConfig) {
	const mssql = await import('mssql');
	const pool = new mssql.ConnectionPool({
		server: config.host || 'localhost',
		port: config.port || 1433,
		database: config.database,
		user: config.username,
		password: config.password,
		options: {
			encrypt: config.ssl ?? false,
			trustServerCertificate: !config.ssl,
			connectTimeout: 5000
		}
	});
	await pool.connect();
	return pool;
}

export class MSSQLAdapter {
	private config: DBConnectionConfig;

	constructor(config: DBConnectionConfig) {
		this.config = config;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		let pool: Awaited<ReturnType<typeof createPool>> | null = null;
		try {
			pool = await createPool(this.config);
			const result = await pool.request().query('SELECT @@VERSION AS v');
			const version = (result.recordset[0]?.v as string)?.split('\n')[0]?.trim();
			return {
				success: true,
				message: 'Connected successfully',
				version,
				latencyMs: Date.now() - start
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : 'Failed to connect' };
		} finally {
			await pool?.close();
		}
	}

	async listTables(): Promise<DBTable[]> {
		let pool: Awaited<ReturnType<typeof createPool>> | null = null;
		try {
			pool = await createPool(this.config);
			const result = await pool.request().query(`
				SELECT
					TABLE_SCHEMA AS [schema],
					TABLE_NAME AS name,
					TABLE_TYPE AS ttype
				FROM INFORMATION_SCHEMA.TABLES
				ORDER BY TABLE_SCHEMA, TABLE_NAME
			`);
			return result.recordset.map((r: any) => ({
				name: r.name,
				schema: r.schema,
				type: (r.ttype === 'VIEW' ? 'view' : 'table') as 'table' | 'view'
			}));
		} finally {
			await pool?.close();
		}
	}

	async describeTable(tableName: string, schema = 'dbo'): Promise<DBColumn[]> {
		let pool: Awaited<ReturnType<typeof createPool>> | null = null;
		try {
			pool = await createPool(this.config);
			const result = await pool.request()
				.input('table', tableName)
				.input('schema', schema)
				.query(`
					SELECT
						c.COLUMN_NAME AS name,
						c.DATA_TYPE AS type,
						c.IS_NULLABLE AS nullable,
						c.COLUMN_DEFAULT AS defaultValue,
						CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS isPrimaryKey
					FROM INFORMATION_SCHEMA.COLUMNS c
					LEFT JOIN (
						SELECT ku.COLUMN_NAME
						FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
						JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
							ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
						WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
							AND tc.TABLE_NAME = @table
							AND tc.TABLE_SCHEMA = @schema
					) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
					WHERE c.TABLE_NAME = @table AND c.TABLE_SCHEMA = @schema
					ORDER BY c.ORDINAL_POSITION
				`);
			return result.recordset.map((c: any) => ({
				name: c.name,
				type: c.type,
				nullable: c.nullable === 'YES',
				primaryKey: c.isPrimaryKey === 1,
				defaultValue: c.defaultValue ?? null
			}));
		} finally {
			await pool?.close();
		}
	}

	async executeQuery(sql: string): Promise<DBQueryResult> {
		let pool: Awaited<ReturnType<typeof createPool>> | null = null;
		const start = Date.now();
		try {
			pool = await createPool(this.config);
			const result = await pool.request().query(sql);
			const executionTimeMs = Date.now() - start;

			if (result.recordset && result.recordset.length > 0) {
				const rows = result.recordset as Record<string, unknown>[];
				return {
					columns: Object.keys(rows[0]),
					rows,
					rowCount: rows.length,
					executionTimeMs
				};
			}
			return {
				columns: ['affectedRows'],
				rows: [{ affectedRows: result.rowsAffected?.[0] ?? 0 }],
				rowCount: result.rowsAffected?.[0] ?? 0,
				executionTimeMs,
				affectedRows: result.rowsAffected?.[0]
			};
		} catch (error) {
			debug.error('database', 'MSSQL query error:', error);
			return {
				columns: [],
				rows: [],
				rowCount: 0,
				executionTimeMs: Date.now() - start,
				error: error instanceof Error ? error.message : 'Query failed'
			};
		} finally {
			await pool?.close();
		}
	}

	async getForeignKeys(tableName: string, schema = 'dbo'): Promise<ForeignKeyDef[]> {
		let pool: Awaited<ReturnType<typeof createPool>> | null = null;
		try {
			pool = await createPool(this.config);
			const result = await pool.request()
				.input('table', tableName)
				.input('schema', schema)
				.query(`
					SELECT
						col.name AS from_col,
						reftbl.name AS to_table,
						refcol.name AS to_col,
						fk.name AS constraint_name,
						fkc.delete_referential_action_desc AS on_delete,
						fkc.update_referential_action_desc AS on_update
					FROM sys.foreign_key_columns fkc
					JOIN sys.foreign_keys fk ON fkc.constraint_object_id = fk.object_id
					JOIN sys.tables tbl ON fk.parent_object_id = tbl.object_id
					JOIN sys.schemas sch ON tbl.schema_id = sch.schema_id
					JOIN sys.columns col ON fkc.parent_object_id = col.object_id AND fkc.parent_column_id = col.column_id
					JOIN sys.tables reftbl ON fkc.referenced_object_id = reftbl.object_id
					JOIN sys.columns refcol ON fkc.referenced_object_id = refcol.object_id AND fkc.referenced_column_id = refcol.column_id
					WHERE tbl.name = @table AND sch.name = @schema
				`);
			return result.recordset.map((r: any) => ({
				fromColumn: r.from_col,
				table: r.to_table,
				column: r.to_col,
				onDelete: r.on_delete?.replace('_', ' ') as ForeignKeyDef['onDelete'],
				onUpdate: r.on_update?.replace('_', ' ') as ForeignKeyDef['onUpdate'],
				constraintName: r.constraint_name
			}));
		} catch {
			return [];
		} finally {
			await pool?.close();
		}
	}

	async getTableData(tableName: string, schema = 'dbo', limit = 100, offset = 0): Promise<DBQueryResult> {
		const safeTable = tableName.replace(/[[\]]/g, '');
		const safeSchema = schema.replace(/[[\]]/g, '');
		return this.executeQuery(
			`SELECT * FROM [${safeSchema}].[${safeTable}] ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
		);
	}
}
