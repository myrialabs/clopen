/**
 * MS SQL Server adapter using the 'mssql' npm library.
 */

import sql from 'mssql';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientObjectColumn,
	DbClientObjectDetails,
	DbClientObjectForeignKey,
	DbClientObjectIndex,
	DbClientOverview,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType,
	DbClientBatchResult,
	DbClientStatementResult
} from '$shared/types/db-client';
import type {
	AlterOperation,
	DbClientDriverAdapter,
	DbClientTxContext,
	IndexDefinition,
	SchemaOpts,
	TableDefinition
} from './types';
import {
	assertSafeIdentifier,
	buildDelete,
	buildInsert,
	buildUpdate,
	qualified,
	quoteMssql,
	renderColumn,
	renderCreateIndex,
	renderCreateTable
} from './sql-builders';
import { POOL_MAX, POOL_IDLE_TIMEOUT_SEC } from '../pool-config';

const Q = quoteMssql;

function isBatchSensitive(q: string): boolean {
	let clean = q.trim();
	while (true) {
		if (clean.startsWith('--')) {
			const idx = clean.indexOf('\n');
			if (idx === -1) {
				clean = '';
				break;
			}
			clean = clean.slice(idx + 1).trim();
		} else if (clean.startsWith('/*')) {
			const idx = clean.indexOf('*/');
			if (idx === -1) {
				clean = '';
				break;
			}
			clean = clean.slice(idx + 2).trim();
		} else {
			break;
		}
	}
	const match = clean.match(/^(create|alter)\s+(procedure|proc|function|view|trigger|schema|queue|default|rule|partition)\b/i);
	return !!match;
}

export class MssqlAdapter implements DbClientDriverAdapter {
	readonly kind = 'mssql' as const;

	private pool: sql.ConnectionPool | null = null;
	private alive = false;
	private conn: DbClientConnection | null = null;

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
		const host = tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
		const port = tunnelPort ?? conn.port ?? 1433;

		const sslMode = conn.sslMode ?? 'disable';
		const encrypt = sslMode !== 'disable';
		// Only skip certificate validation for the non-verifying modes. In
		// `verify-ca`/`verify-full` the user explicitly asked us to validate the
		// server certificate, so trusting any cert there would be an MITM hole.
		const trustServerCertificate = sslMode !== 'verify-ca' && sslMode !== 'verify-full';

		const config: sql.config = {
			server: host,
			port: port,
			user: conn.username ?? undefined,
			password: conn.password ?? undefined,
			database: conn.database ?? undefined,
			options: {
				encrypt,
				trustServerCertificate,
				enableArithAbort: true
			},
			pool: {
				max: POOL_MAX,
				min: 0,
				idleTimeoutMillis: POOL_IDLE_TIMEOUT_SEC * 1000
			}
		};

		this.pool = new sql.ConnectionPool(config);
		await this.pool.connect();
		this.conn = conn;
		this.alive = true;
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.pool) {
			await this.pool.close();
			this.pool = null;
		}
	}

	isAlive(): boolean {
		return this.alive && this.pool !== null && this.pool.connected;
	}

	private requirePool(): sql.ConnectionPool {
		if (!this.pool || !this.pool.connected) {
			throw new Error('SQL Server not connected');
		}
		return this.pool;
	}

	async health(): Promise<DbClientHealth> {
		if (!this.pool) return notConnected();
		const start = performance.now();
		try {
			const request = this.pool.request();
			const res = await request.query('SELECT @@VERSION AS version');
			const version = res.recordset[0]?.version ?? null;
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - start),
				serverVersion: version,
				sshOk: null,
				error: null
			};
		} catch (err) {
			return {
				ok: false,
				latencyMs: null,
				serverVersion: null,
				sshOk: null,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	}

	/** Bind positional params as @p0, @p1, … on an mssql request. */
	private bindParams(request: sql.Request, params: unknown[]): void {
		if (params && params.length > 0) {
			params.forEach((val, idx) => {
				request.input(`p${idx}`, val);
			});
		}
	}

	/** Map a raw mssql result into a DbClientQueryResult, attaching a per-statement
	 *  `batch` report when the query produced multiple recordsets. */
	private buildResult(result: sql.IResult<any>, q: string, durationMs: number): DbClientQueryResult {
		const toColumns = (rows: any[]) => rows.length > 0
			? Object.keys(rows[0]).map((name) => ({ name, type: null as string | null }))
			: [];

		const recordsets = result.recordsets as any[] | undefined;
		if (recordsets && recordsets.length > 1) {
			const candidateSplit = q.split(/;|\n\s*\n/).map(s => s.trim()).filter(Boolean);
			const hasMatchingSplit = candidateSplit.length === recordsets.length;
			const statements: DbClientStatementResult[] = recordsets.map((recordset: any, idx: number) => ({
				index: idx,
				query: hasMatchingSplit ? candidateSplit[idx] : `Statement ${idx + 1}`,
				queryClass: 'read' as const,
				status: 'success' as const,
				result: {
					columns: toColumns(recordset),
					rows: recordset,
					rowCount: recordset.length,
					affectedRows: result.rowsAffected ? (result.rowsAffected[idx] ?? null) : null,
					durationMs: 0,
					driverMeta: {}
				},
				error: null,
				durationMs: 0
			}));
			const batchResult: DbClientBatchResult = {
				statements,
				totalDurationMs: durationMs,
				transaction: false,
				ok: true
			};
			return {
				columns: statements[0].result?.columns ?? [],
				rows: recordsets[0] || [],
				rowCount: recordsets[0]?.length ?? 0,
				affectedRows: result.rowsAffected ? (result.rowsAffected[0] ?? null) : null,
				durationMs,
				driverMeta: {},
				batch: batchResult
			};
		}

		const rows = result.recordset || [];
		return {
			columns: toColumns(rows),
			rows,
			rowCount: rows.length,
			affectedRows: result.rowsAffected ? result.rowsAffected[0] : null,
			durationMs,
			driverMeta: {}
		};
	}

	async executeRead(q: string, params: unknown[] = [], opts?: { database?: string; limit?: number }): Promise<DbClientQueryResult> {
		const pool = this.requirePool();
		const start = performance.now();
		const needUse = opts?.database && opts.database.toLowerCase() !== this.conn?.database?.toLowerCase();

		if (needUse && isBatchSensitive(q)) {
			// Batch-sensitive DDL (CREATE PROCEDURE, …) can't share a batch with
			// `USE`, so run the database switch as a separate request first, wrapped
			// in a transaction for atomicity.
			const transaction = new sql.Transaction(pool);
			await transaction.begin();
			try {
				const useRequest = new sql.Request(transaction);
				await useRequest.query(`USE ${Q(opts!.database as string)}`);

				const request = new sql.Request(transaction);
				this.bindParams(request, params);
				const result = await request.query(q);
				await transaction.commit();
				return this.buildResult(result, q, Math.round(performance.now() - start));
			} catch (err) {
				try {
					await transaction.rollback();
				} catch {
					// Ignore rollback failures to avoid swallowing the original error
				}
				throw err;
			}
		}

		const request = pool.request();
		this.bindParams(request, params);
		const finalQuery = needUse ? `USE ${Q(opts!.database as string)};\n${q}` : q;
		const result = await request.query(finalQuery);
		return this.buildResult(result, q, Math.round(performance.now() - start));
	}

	async executeWrite(q: string, params: unknown[] = [], opts?: { database?: string }): Promise<DbClientQueryResult> {
		return this.executeRead(q, params, opts);
	}

	async withTransaction<T>(
		fn: (tx: DbClientTxContext) => Promise<T>,
		opts?: { database?: string }
	): Promise<T> {
		const pool = this.requirePool();
		const transaction = new sql.Transaction(pool);
		await transaction.begin();

		const txDb = opts?.database;

		try {
			const txContext: DbClientTxContext = {
				executeRead: async (q, params, txOpts) => {
					const db = txOpts?.database || txDb;
					const needUse = db && db.toLowerCase() !== this.conn?.database?.toLowerCase();
					if (needUse) {
						const useRequest = new sql.Request(transaction);
						await useRequest.query(`USE ${Q(db as string)}`);
					}
					const request = new sql.Request(transaction);
					this.bindParams(request, params ?? []);
					const start = performance.now();
					const result = await request.query(q);
					const durationMs = Math.round(performance.now() - start);
					const rows = result.recordset || [];
					const columns = rows.length > 0
						? Object.keys(rows[0]).map((name) => ({ name, type: null as string | null }))
						: [];
					return {
						columns,
						rows,
						rowCount: rows.length,
						affectedRows: result.rowsAffected ? result.rowsAffected[0] : null,
						durationMs,
						driverMeta: {}
					};
				},
				executeWrite: async (q, params, txOpts) => {
					const db = txOpts?.database || txDb;
					const needUse = db && db.toLowerCase() !== this.conn?.database?.toLowerCase();
					if (needUse) {
						const useRequest = new sql.Request(transaction);
						await useRequest.query(`USE ${Q(db as string)}`);
					}
					const request = new sql.Request(transaction);
					this.bindParams(request, params ?? []);
					const start = performance.now();
					const result = await request.query(q);
					const durationMs = Math.round(performance.now() - start);
					return {
						columns: [],
						rows: [],
						rowCount: 0,
						affectedRows: result.rowsAffected ? result.rowsAffected[0] : null,
						durationMs,
						driverMeta: {}
					};
				}
			};

			const out = await fn(txContext);
			await transaction.commit();
			return out;
		} catch (err) {
			try {
				await transaction.rollback();
			} catch {
				// Ignore rollback failures
			}
			throw err;
		}
	}

	// ── Overview ──────────────────────────────────────────────────────────

	async overview(opts?: SchemaOpts): Promise<DbClientOverview> {
		const pool = this.requirePool();
		const start = performance.now();
		const db = opts?.database || this.conn?.database || 'master';

		const health = await this.health();
		const latencyMs = Math.round(performance.now() - start);

		// Size overview
		const sizeRes = await this.executeRead(`
			SELECT SUM(CAST(size AS BIGINT) * 8 * 1024) AS size_bytes
			FROM sys.master_files
			WHERE database_id = DB_ID(@p0)
		`, [db]);
		const sizeBytes = Number(sizeRes.rows[0]?.size_bytes ?? 0);

		// Tables and views count
		const tablesRes = await this.executeRead(`
			SELECT COUNT(*) AS tables_count
			FROM sys.tables
		`);
		const viewsRes = await this.executeRead(`
			SELECT COUNT(*) AS views_count
			FROM sys.views
		`);

		return {
			serverVersion: health.serverVersion,
			latencyMs,
			sizeBytes,
			tableCount: Number(tablesRes.rows[0]?.tables_count ?? 0),
			viewCount: Number(viewsRes.rows[0]?.views_count ?? 0),
			extra: [
				{ label: 'Database', value: db }
			]
		};
	}

	// ── Schema ────────────────────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		const res = await this.executeRead(`
			SELECT name
			FROM sys.databases
			WHERE state = 0 AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
			ORDER BY name
		`);
		return res.rows.map((r) => ({
			name: String(r.name),
			type: 'database' as const
		}));
	}

	async listSchemas(database?: string): Promise<DbClientSchemaNode[]> {
		const dbPrefix = database ? `${Q(database)}.` : '';
		const res = await this.executeRead(`
			SELECT name FROM ${dbPrefix}sys.schemas
			WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA')
			ORDER BY name
		`);
		return res.rows.map((r) => ({
			name: String(r.name),
			type: 'schema' as const
		}));
	}

	async listObjects(database?: string, schema?: string): Promise<DbClientSchemaNode[]> {
		const dbPrefix = database ? `${Q(database)}.` : '';
		const schemaName = schema || 'dbo';
		const res = await this.executeRead(`
			SELECT t.name, t.type_desc
			FROM ${dbPrefix}sys.objects t
			INNER JOIN ${dbPrefix}sys.schemas s ON t.schema_id = s.schema_id
			WHERE t.type IN ('U', 'V', 'P', 'FN', 'TF', 'IF') AND s.name = @p0
			ORDER BY t.name
		`, [schemaName]);

		return res.rows.map((r) => {
			const typeDesc = String(r.type_desc);
			let type: DbClientSchemaNodeType = 'table';
			if (typeDesc === 'VIEW') {
				type = 'view';
			} else if (typeDesc === 'SQL_STORED_PROCEDURE') {
				type = 'procedure';
			} else if (
				typeDesc === 'SQL_SCALAR_FUNCTION' ||
				typeDesc === 'SQL_TABLE_VALUED_FUNCTION' ||
				typeDesc === 'SQL_INLINE_TABLE_VALUED_FUNCTION'
			) {
				type = 'function';
			}
			return {
				name: String(r.name),
				type
			};
		});
	}

	async getObjectDetails(
		name: string,
		_type: DbClientSchemaNodeType,
		database?: string,
		schema?: string
	): Promise<DbClientObjectDetails> {
		const targetSchema = schema || 'dbo';
		const dbPrefix = database ? `${Q(database)}.` : '';

		if (_type === 'function' || _type === 'procedure') {
			// Bind the object name as a parameter so an object name containing a
			// quote can't break out of the OBJECT_ID string literal.
			const objectRef = `${dbPrefix}${Q(targetSchema)}.${Q(name)}`;
			const res = await this.executeRead(`
				SELECT definition
				FROM ${dbPrefix}sys.sql_modules
				WHERE object_id = OBJECT_ID(@p0)
			`, [objectRef]);
			const definition = res.rows[0]?.definition ?? '';
			return {
				name,
				type: _type,
				ddl: String(definition)
			};
		}

		// Columns details
		const colQuery = `
			SELECT
				c.COLUMN_NAME,
				c.DATA_TYPE,
				c.IS_NULLABLE,
				c.COLUMN_DEFAULT,
				CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PRIMARY,
				CASE WHEN uk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_UNIQUE
			FROM ${dbPrefix}INFORMATION_SCHEMA.COLUMNS c
			LEFT JOIN (
				SELECT kcu.COLUMN_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME
				FROM ${dbPrefix}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
				JOIN ${dbPrefix}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
				 AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
				WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
			) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
			LEFT JOIN (
				SELECT kcu.COLUMN_NAME, kcu.TABLE_SCHEMA, kcu.TABLE_NAME
				FROM ${dbPrefix}INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
				JOIN ${dbPrefix}INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
				  ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
				 AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
				WHERE tc.CONSTRAINT_TYPE = 'UNIQUE'
			) uk ON uk.TABLE_SCHEMA = c.TABLE_SCHEMA AND uk.TABLE_NAME = c.TABLE_NAME AND uk.COLUMN_NAME = c.COLUMN_NAME
			WHERE c.TABLE_SCHEMA = @p0 AND c.TABLE_NAME = @p1
			ORDER BY c.ORDINAL_POSITION
		`;
		const colRows = await this.executeRead(colQuery, [targetSchema, name]);

		const columns: DbClientObjectColumn[] = colRows.rows.map((r) => ({
			name: String(r.COLUMN_NAME),
			type: String(r.DATA_TYPE ?? ''),
			nullable: r.IS_NULLABLE === 'YES',
			default: r.COLUMN_DEFAULT === null ? null : String(r.COLUMN_DEFAULT),
			isPrimary: r.IS_PRIMARY === 1,
			isUnique: r.IS_UNIQUE === 1
		}));

		// Indexes
		const idxQuery = `
			SELECT
				i.name AS index_name,
				c.name AS column_name,
				i.is_unique
			FROM ${dbPrefix}sys.indexes i
			INNER JOIN ${dbPrefix}sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
			INNER JOIN ${dbPrefix}sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
			INNER JOIN ${dbPrefix}sys.tables t ON i.object_id = t.object_id
			INNER JOIN ${dbPrefix}sys.schemas s ON t.schema_id = s.schema_id
			WHERE s.name = @p0 AND t.name = @p1 AND i.name IS NOT NULL
			ORDER BY i.name, ic.key_ordinal
		`;
		const idxRows = await this.executeRead(idxQuery, [targetSchema, name]);

		const indexes: DbClientObjectIndex[] = [];
		const indexGroups = new Map<string, { columns: string[]; unique: boolean }>();
		for (const r of idxRows.rows) {
			const idxName = String(r.index_name);
			const colName = String(r.column_name);
			const isUnique = r.is_unique === 1 || r.is_unique === true;

			if (!indexGroups.has(idxName)) {
				indexGroups.set(idxName, { columns: [], unique: isUnique });
			}
			indexGroups.get(idxName)!.columns.push(colName);
		}

		for (const [idxName, val] of indexGroups.entries()) {
			indexes.push({
				name: idxName,
				columns: val.columns,
				unique: val.unique
			});
		}

		// Foreign Keys
		const fkQuery = `
			SELECT
				fk.name AS constraint_name,
				tp.name AS column_name,
				rt.name AS ref_table,
				rp.name AS ref_column
			FROM ${dbPrefix}sys.foreign_keys fk
			INNER JOIN ${dbPrefix}sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
			INNER JOIN ${dbPrefix}sys.tables t ON fkc.parent_object_id = t.object_id
			INNER JOIN ${dbPrefix}sys.schemas s ON t.schema_id = s.schema_id
			INNER JOIN ${dbPrefix}sys.columns tp ON fkc.parent_object_id = tp.object_id AND fkc.parent_column_id = tp.column_id
			INNER JOIN ${dbPrefix}sys.tables rt ON fkc.referenced_object_id = rt.object_id
			INNER JOIN ${dbPrefix}sys.columns rp ON fkc.referenced_object_id = rp.object_id AND fkc.referenced_column_id = rp.column_id
			WHERE s.name = @p0 AND t.name = @p1
		`;
		const fkRows = await this.executeRead(fkQuery, [targetSchema, name]);

		const foreignKeys: DbClientObjectForeignKey[] = fkRows.rows.map((r) => ({
			column: String(r.column_name),
			refTable: String(r.ref_table),
			refColumn: String(r.ref_column)
		}));

		return { name, type: 'table', columns, indexes, foreignKeys };
	}

	// ── Structure ─────────────────────────────────────────────────────────

	async createDatabase(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `CREATE DATABASE ${Q(name)}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async dropDatabase(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP DATABASE ${Q(name)}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async renameDatabase(name: string, newName: string): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const ddl = `ALTER DATABASE ${Q(name)} MODIFY NAME = ${Q(newName)}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async resetDatabase(opts?: SchemaOpts): Promise<string> {
		const schema = opts?.schema || 'dbo';
		const dbPrefix = opts?.database ? `${Q(opts.database)}.` : '';

		const res = await this.executeRead(
			`SELECT TABLE_NAME FROM ${dbPrefix}INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p0 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
			[schema]
		);
		if (res.rows.length === 0) return '-- no tables to empty';
		res.rows.forEach((r) => assertSafeIdentifier(String(r.TABLE_NAME)));

		const ddls: string[] = [];

		// Disable constraints
		for (const r of res.rows) {
			const tableName = qualified(Q, [opts?.database, schema, String(r.TABLE_NAME)]);
			ddls.push(`ALTER TABLE ${tableName} NOCHECK CONSTRAINT ALL`);
		}

		// Delete data & reset identity
		for (const r of res.rows) {
			const tableName = qualified(Q, [opts?.database, schema, String(r.TABLE_NAME)]);
			ddls.push(`DELETE FROM ${tableName}`);
			ddls.push(`IF OBJECTPROPERTY(OBJECT_ID('${tableName}'), 'TableHasIdentity') = 1 DBCC CHECKIDENT ('${tableName}', RESEED, 0)`);
		}

		// Re-enable constraints
		for (const r of res.rows) {
			const tableName = qualified(Q, [opts?.database, schema, String(r.TABLE_NAME)]);
			ddls.push(`ALTER TABLE ${tableName} CHECK CONSTRAINT ALL`);
		}

		const fullQuery = ddls.join(';\n');
		await this.executeWrite(fullQuery);
		return fullQuery;
	}

	async createTable(definition: TableDefinition, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(definition.name);
		const ddl = renderCreateTable({
			quote: Q,
			definition,
			schema: opts?.schema || 'dbo',
			database: opts?.database,
			driver: 'mssql'
		});
		await this.executeWrite(ddl);
		return ddl;
	}

	async alterTable(name: string, operations: AlterOperation[], opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const schema = opts?.schema || 'dbo';
		const fqt = qualified(Q, [opts?.database, schema, name]);
		const ddls: string[] = [];

		for (const op of operations) {
			switch (op.kind) {
				case 'add-column':
					assertSafeIdentifier(op.column.name);
					ddls.push(`ALTER TABLE ${fqt} ADD ${renderColumn({ quote: Q, column: op.column, driver: 'mssql' })}`);
					break;
				case 'drop-column':
					assertSafeIdentifier(op.name);
					ddls.push(`ALTER TABLE ${fqt} DROP COLUMN ${Q(op.name)}`);
					break;
				case 'rename-column':
					assertSafeIdentifier(op.name);
					assertSafeIdentifier(op.newName);
					const objectPath = `${schema}.${name}.${op.name}`;
					ddls.push(`EXEC sp_rename '${objectPath}', '${op.newName}', 'COLUMN'`);
					break;
				case 'modify-column':
					assertSafeIdentifier(op.column.name);
					const parts = [Q(op.column.name), op.column.type];
					if (op.column.nullable === false) parts.push('NOT NULL');
					else parts.push('NULL');
					ddls.push(`ALTER TABLE ${fqt} ALTER COLUMN ${parts.join(' ')}`);
					break;
			}
		}

		const fullQuery = ddls.join(';\n');
		await this.executeWrite(fullQuery);
		return fullQuery;
	}

	async dropTable(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP TABLE ${qualified(Q, [opts?.database, opts?.schema || 'dbo', name])}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async truncateTable(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `TRUNCATE TABLE ${qualified(Q, [opts?.database, opts?.schema || 'dbo', name])}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async resetTable(name: string, opts?: SchemaOpts): Promise<string> {
		// TRUNCATE TABLE resets identity naturally in SQL Server
		return this.truncateTable(name, opts);
	}

	async renameTable(name: string, newName: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const schema = opts?.schema || 'dbo';
		const objectPath = `${schema}.${name}`;
		const ddl = `EXEC sp_rename '${objectPath}', '${newName}'`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async duplicateTable(name: string, newName: string, opts?: SchemaOpts & { withData?: boolean }): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const schema = opts?.schema || 'dbo';
		const source = qualified(Q, [opts?.database, schema, name]);
		const target = qualified(Q, [opts?.database, schema, newName]);
		const where = opts?.withData ? '' : ' WHERE 1 = 0';
		const ddl = `SELECT * INTO ${target} FROM ${source}${where}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async getCreateStatement(name: string, type: DbClientSchemaNodeType, opts?: SchemaOpts): Promise<string> {
		const details = await this.getObjectDetails(name, type, opts?.database, opts?.schema);
		const schema = opts?.schema || 'dbo';
		const detailColumns = details.columns ?? [];
		const cols = detailColumns.map((c) => {
			const parts = [Q(c.name), c.type];
			if (!c.nullable) parts.push('NOT NULL');
			if (c.default !== null && c.default !== undefined && c.default !== '') parts.push(`DEFAULT ${c.default}`);
			return `  ${parts.join(' ')}`;
		});
		const pk = detailColumns.filter((c) => c.isPrimary).map((c) => Q(c.name));
		if (pk.length > 0) cols.push(`  PRIMARY KEY (${pk.join(', ')})`);
		const lines = [`CREATE TABLE ${qualified(Q, [opts?.database, schema, name])} (`, cols.join(',\n'), ');'];
		return lines.join('\n');
	}

	async createIndex(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(def.name);
		def.columns.forEach(assertSafeIdentifier);
		const ddl = renderCreateIndex({
			quote: Q,
			tableName,
			def,
			schema: opts?.schema || 'dbo',
			database: opts?.database
		});
		await this.executeWrite(ddl);
		return ddl;
	}

	async dropIndex(tableName: string, indexName: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(indexName);
		const fqt = qualified(Q, [opts?.database, opts?.schema || 'dbo', tableName]);
		const ddl = `DROP INDEX ${Q(indexName)} ON ${fqt}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async createView(name: string, query: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const fqt = qualified(Q, [opts?.database, opts?.schema || 'dbo', name]);
		const ddl = `CREATE VIEW ${fqt} AS ${query}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	async dropView(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const fqt = qualified(Q, [opts?.database, opts?.schema || 'dbo', name]);
		const ddl = `DROP VIEW ${fqt}`;
		await this.executeWrite(ddl);
		return ddl;
	}

	// ── Data CRUD ─────────────────────────────────────────────────────────

	async insertRow(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		Object.keys(row).forEach(assertSafeIdentifier);
		const { sql: query, params } = buildInsert({
			quote: Q,
			table,
			row,
			schema: opts?.schema || 'dbo',
			database: opts?.database,
			placeholder: (i) => `@p${i}`
		});
		return this.executeWrite(query, params);
	}

	async updateRow(
		table: string,
		pk: Record<string, unknown>,
		changes: Record<string, unknown>,
		opts?: SchemaOpts
	): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		[...Object.keys(pk), ...Object.keys(changes)].forEach(assertSafeIdentifier);
		const { sql: query, params } = buildUpdate({
			quote: Q,
			table,
			pk,
			changes,
			schema: opts?.schema || 'dbo',
			database: opts?.database,
			placeholder: (i) => `@p${i}`
		});
		return this.executeWrite(query, params);
	}

	async deleteRows(table: string, pks: Record<string, unknown>[], opts?: SchemaOpts): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		if (pks.length > 0) Object.keys(pks[0]).forEach(assertSafeIdentifier);
		const { sql: query, params } = buildDelete({
			quote: Q,
			table,
			pks,
			schema: opts?.schema || 'dbo',
			database: opts?.database,
			placeholder: (i) => `@p${i}`
		});
		return this.executeWrite(query, params);
	}
}

function notConnected(): DbClientHealth {
	return {
		ok: false,
		latencyMs: null,
		serverVersion: null,
		sshOk: null,
		error: 'Not connected'
	};
}
