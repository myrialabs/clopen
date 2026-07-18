/**
 * MySQL adapter — Bun.sql (mysql://) per PHASE 0 findings.
 */

import { SQL } from 'bun';
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
	DbClientSchemaNodeType
} from '$shared/types/db-client';
import type {
	AlterOperation,
	DbClientDriverAdapter,
	DbClientTxContext,
	IndexDefinition,
	SchemaOpts,
	TableDefinition
} from './types';
import { normalizeBunSqlResult } from './bun-sql-helpers';
import {
	assertSafeIdentifier,
	buildDelete,
	buildInsert,
	buildUpdate,
	qualified,
	quoteMysql,
	renderColumn,
	renderCreateIndex,
	renderCreateTable
} from './sql-builders';
import { debug } from '$shared/utils/logger';

const Q = quoteMysql;

export class MysqlAdapter implements DbClientDriverAdapter {
	readonly kind = 'mysql' as const;

	private sql: SQL | null = null;
	private alive = false;
	// The session's currently-USEd database (mutated by ensureDatabase).
	private defaultDb: string | null = null;
	// The connection's configured database — immutable, used as the scope
	// fallback so a connection-level overview never resolves to the last-browsed
	// database that only the session happens to be sitting on.
	private configuredDb: string | null = null;
	private ensureLock = Promise.resolve();

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
		const host = tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
		const port = tunnelPort ?? conn.port ?? 3306;
		const user = encodeURIComponent(conn.username ?? '');
		const pass = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
		const auth = user ? `${user}${pass}@` : '';
		const db = conn.database ? `/${encodeURIComponent(conn.database)}` : '';

		const url = `mysql://${auth}${host}:${port}${db}`;
		this.sql = new SQL(url);
		await this.sql.connect();
		this.defaultDb = conn.database || null;
		this.configuredDb = conn.database || null;
		this.alive = true;
	}

	async close(): Promise<void> {
		let release: () => void;
		const prev = this.ensureLock;
		this.ensureLock = new Promise<void>((resolve) => { release = resolve; });
		await prev;

		try {
			this.alive = false;
			this.defaultDb = null;
			if (!this.sql) return;
			await this.sql.close().catch((err) => debug.warn('db-client', 'MySQL close error:', err));
			this.sql = null;
		} finally {
			release!();
		}
	}

	isAlive(): boolean {
		return this.alive && this.sql !== null;
	}

	async health(): Promise<DbClientHealth> {
		if (!this.sql) return notConnected();
		const start = performance.now();
		try {
			const rows = (await this.sql.unsafe('SELECT VERSION() AS version')) as Array<{ version: string }>;
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - start),
				serverVersion: rows[0]?.version ?? null,
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

	private requireSql(): SQL {
		if (!this.sql) throw new Error('MySQL not connected');
		return this.sql;
	}

	private targetDb(opts?: SchemaOpts): string | undefined {
		// Fall back to the configured database, never the session's last-USEd one.
		return opts?.database || this.configuredDb || undefined;
	}

	private async ensureDatabase(database?: string): Promise<void> {
		if (!database) return;
		if (database === this.defaultDb) return;

		let release: () => void;
		const prev = this.ensureLock;
		this.ensureLock = new Promise<void>((resolve) => { release = resolve; });
		await prev;

		try {
			if (database === this.defaultDb) return;
			const sql = this.requireSql();
			assertSafeIdentifier(database);
			await sql.unsafe(`USE ${quoteMysql(database)}`);
			this.defaultDb = database;
		} finally {
			release!();
		}
	}

	async executeRead(q: string, params: unknown[] = [], opts?: { database?: string }): Promise<DbClientQueryResult> {
		await this.ensureDatabase(opts?.database);
		const sql = this.requireSql();
		const start = performance.now();
		const raw = await sql.unsafe(q, params as never);
		return normalizeBunSqlResult(raw, Math.round(performance.now() - start));
	}

	async executeWrite(q: string, params: unknown[] = [], opts?: { database?: string }): Promise<DbClientQueryResult> {
		return this.executeRead(q, params, opts);
	}

	async explain(q: string, opts?: { database?: string }): Promise<DbClientQueryResult> {
		return this.executeRead(`EXPLAIN ${q}`, [], opts);
	}

	async withTransaction<T>(fn: (tx: DbClientTxContext) => Promise<T>, opts?: { database?: string }): Promise<T> {
		await this.ensureDatabase(opts?.database);
		const sql = this.requireSql();
		// Bun.sql reserves one connection for the `begin` block. Note: MySQL
		// implicitly commits on DDL (CREATE/ALTER/DROP/…), so a batch that
		// mixes DDL with later failures cannot fully roll back the DDL — a
		// server limitation, not an app one.
		return sql.begin(async (tx) => {
			const run = async (q: string, params: unknown[] = []): Promise<DbClientQueryResult> => {
				const start = performance.now();
				const raw = await tx.unsafe(q, params as never);
				return normalizeBunSqlResult(raw, Math.round(performance.now() - start));
			};
			return fn({
				executeRead: (q, params) => run(q, params ?? []),
				executeWrite: (q, params) => run(q, params ?? [])
			});
		}) as Promise<T>;
	}

	// ── Overview ──────────────────────────────────────────────────────────

	async overview(opts?: SchemaOpts): Promise<DbClientOverview> {
		const sql = this.requireSql();
		const start = performance.now();
		const verRows = (await sql.unsafe('SELECT VERSION() AS v')) as Array<{ v: string }>;
		const latencyMs = Math.round(performance.now() - start);
		const target = this.targetDb(opts);
		if (!target) {
			// Connection level — aggregate across all user databases on the server.
			const rows = (await sql.unsafe(
				`SELECT
				   COUNT(DISTINCT table_schema) AS dbs,
				   SUM(data_length + index_length) AS size,
				   SUM(table_type = 'BASE TABLE') AS tables,
				   SUM(table_type = 'VIEW') AS views
				 FROM information_schema.tables
				 WHERE table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')`
			)) as Array<Record<string, unknown>>;
			const r = rows[0] ?? {};
			return {
				serverVersion: verRows[0]?.v ?? null,
				latencyMs,
				sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
				tableCount: r.tables === null || r.tables === undefined ? null : Number(r.tables),
				viewCount: r.views === null || r.views === undefined ? null : Number(r.views),
				extra: [{ label: 'Databases', value: String(r.dbs === null || r.dbs === undefined ? 0 : Number(r.dbs)) }]
			};
		}
		const rows = (await sql.unsafe(
			`SELECT
			   SUM(data_length + index_length) AS size,
			   SUM(table_type = 'BASE TABLE') AS tables,
			   SUM(table_type = 'VIEW') AS views
			 FROM information_schema.tables WHERE table_schema = ?`,
			[target] as never
		)) as Array<Record<string, unknown>>;
		const r = rows[0] ?? {};
		return {
			serverVersion: verRows[0]?.v ?? null,
			latencyMs,
			sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
			tableCount: r.tables === null || r.tables === undefined ? null : Number(r.tables),
			viewCount: r.views === null || r.views === undefined ? null : Number(r.views),
			extra: [{ label: 'Database', value: target }]
		};
	}

	// ── Schema ────────────────────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		const rows = (await this.requireSql().unsafe('SHOW DATABASES')) as Array<Record<string, string>>;
		return rows.map((r) => {
			const name = Object.values(r)[0];
			return { name, type: 'database' as const };
		});
	}

	async listObjects(database?: string): Promise<DbClientSchemaNode[]> {
		const target = this.targetDb({ database });
		if (!target) throw new Error('MySQL: database is required');
		const tables = (await this.requireSql().unsafe(
			'SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.tables WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
			[target] as never
		)) as Array<{ TABLE_NAME: string; TABLE_TYPE: string }>;

		const routines = (await this.requireSql().unsafe(
			'SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.routines WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
			[target] as never
		)) as Array<{ ROUTINE_NAME: string; ROUTINE_TYPE: string }>;

		const tableNodes = tables.map((r) => ({
			name: r.TABLE_NAME,
			type: r.TABLE_TYPE === 'VIEW' ? ('view' as const) : ('table' as const)
		}));

		const routineNodes = routines.map((r) => ({
			name: r.ROUTINE_NAME,
			type: r.ROUTINE_TYPE === 'FUNCTION' ? ('function' as const) : ('procedure' as const)
		}));

		return [...tableNodes, ...routineNodes];
	}

	async getObjectDetails(
		name: string,
		_type: DbClientSchemaNodeType,
		database?: string
	): Promise<DbClientObjectDetails> {
		const target = this.targetDb({ database });
		if (!target) throw new Error('MySQL: database is required');
		const sql = this.requireSql();

		if (_type === 'function' || _type === 'procedure') {
			const query = _type === 'function'
				? `SHOW CREATE FUNCTION ${Q(target)}.${Q(name)}`
				: `SHOW CREATE PROCEDURE ${Q(target)}.${Q(name)}`;
			
			const res = (await sql.unsafe(query)) as any[];
			const field = _type === 'function' ? 'Create Function' : 'Create Procedure';
			const definition = res[0]?.[field] ?? res[0]?.[field.toUpperCase()] ?? '';
			return {
				name,
				type: _type,
				ddl: String(definition)
			};
		}

		const colRows = (await sql.unsafe(
			`SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
			 FROM information_schema.columns
			 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
			 ORDER BY ORDINAL_POSITION`,
			[target, name] as never
		)) as Array<Record<string, unknown>>;

		const columns: DbClientObjectColumn[] = colRows.map((r) => ({
			name: String(r.COLUMN_NAME),
			type: String(r.COLUMN_TYPE ?? r.DATA_TYPE ?? ''),
			nullable: r.IS_NULLABLE === 'YES',
			default: r.COLUMN_DEFAULT === null ? null : String(r.COLUMN_DEFAULT),
			isPrimary: r.COLUMN_KEY === 'PRI',
			isUnique: r.COLUMN_KEY === 'UNI'
		}));

		const idxRows = (await sql.unsafe(
			`SHOW INDEXES FROM ${Q(name)} FROM ${Q(target)}`
		)) as Array<Record<string, unknown>>;
		const indexMap = new Map<string, DbClientObjectIndex>();
		for (const r of idxRows) {
			const key = String(r.Key_name);
			const existing = indexMap.get(key);
			if (existing) {
				existing.columns.push(String(r.Column_name));
			} else {
				indexMap.set(key, {
					name: key,
					columns: [String(r.Column_name)],
					unique: r.Non_unique === 0 || r.Non_unique === '0',
					type: typeof r.Index_type === 'string' ? r.Index_type : undefined
				});
			}
		}

		const fkRows = (await sql.unsafe(
			`SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
			 FROM information_schema.key_column_usage
			 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
			[target, name] as never
		)) as Array<Record<string, unknown>>;

		const foreignKeys: DbClientObjectForeignKey[] = fkRows.map((r) => ({
			column: String(r.COLUMN_NAME),
			refTable: String(r.REFERENCED_TABLE_NAME),
			refColumn: String(r.REFERENCED_COLUMN_NAME)
		}));

		return {
			name,
			type: 'table',
			columns,
			indexes: [...indexMap.values()],
			foreignKeys
		};
	}

	// ── Structure ─────────────────────────────────────────────────────────

	async createDatabase(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `CREATE DATABASE ${Q(name)}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropDatabase(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP DATABASE ${Q(name)}`;
		await this.requireSql().unsafe(ddl);
		if (this.defaultDb === name) this.defaultDb = null;
		return ddl;
	}

	async renameDatabase(name: string, newName: string): Promise<string> {
		// MySQL has no RENAME DATABASE. Create the target, move every base table
		// into it (RENAME TABLE moves data instantly, no copy), then drop the old
		// one. Tables (and their data) are migrated losslessly.
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const sql = this.requireSql();
		await sql.unsafe(`CREATE DATABASE ${Q(newName)}`);
		const rows = (await sql.unsafe(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
			[name] as never
		)) as Array<{ TABLE_NAME: string }>;
		for (const r of rows) {
			assertSafeIdentifier(r.TABLE_NAME);
			await sql.unsafe(`RENAME TABLE ${qualified(Q, [name, r.TABLE_NAME])} TO ${qualified(Q, [newName, r.TABLE_NAME])}`);
		}
		await sql.unsafe(`DROP DATABASE ${Q(name)}`);
		// Force a fresh `USE` on next access — the session's selected db is gone.
		if (this.defaultDb === name) this.defaultDb = null;
		return `CREATE DATABASE ${Q(newName)}; RENAME TABLE …; DROP DATABASE ${Q(name)}`;
	}

	async resetDatabase(opts?: SchemaOpts): Promise<string> {
		const target = this.targetDb(opts);
		if (!target) throw new Error('MySQL: database is required');
		const sql = this.requireSql();
		const rows = (await sql.unsafe(
			"SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
			[target] as never
		)) as Array<{ TABLE_NAME: string }>;
		if (rows.length === 0) return '-- no tables to empty';
		rows.forEach((r) => assertSafeIdentifier(r.TABLE_NAME));
		const statements = rows.map((r) => `TRUNCATE TABLE ${qualified(Q, [target, r.TABLE_NAME])}`);
		await sql.unsafe('SET FOREIGN_KEY_CHECKS = 0');
		try {
			for (const stmt of statements) await sql.unsafe(stmt);
		} finally {
			await sql.unsafe('SET FOREIGN_KEY_CHECKS = 1');
		}
		return statements.join(';\n');
	}

	async resetTable(name: string, opts?: SchemaOpts): Promise<string> {
		// MySQL TRUNCATE already resets AUTO_INCREMENT.
		return this.truncateTable(name, opts);
	}

	async duplicateTable(name: string, newName: string, opts?: (SchemaOpts & { withData?: boolean })): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const db = this.targetDb(opts);
		const src = qualified(Q, [db, name]);
		const dst = qualified(Q, [db, newName]);
		const sql = this.requireSql();
		const create = `CREATE TABLE ${dst} LIKE ${src}`;
		await sql.unsafe(create);
		const statements = [create];
		if (opts?.withData) {
			const copy = `INSERT INTO ${dst} SELECT * FROM ${src}`;
			await sql.unsafe(copy);
			statements.push(copy);
		}
		return statements.join(';\n');
	}

	async getCreateStatement(name: string, type: DbClientSchemaNodeType, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const fqt = qualified(Q, [this.targetDb(opts), name]);
		const keyword = type === 'view' ? 'VIEW' : 'TABLE';
		const rows = (await this.requireSql().unsafe(`SHOW CREATE ${keyword} ${fqt}`)) as Array<Record<string, unknown>>;
		const row = rows[0] ?? {};
		const ddl = row['Create Table'] ?? row['Create View'] ?? Object.values(row)[1];
		return String(ddl ?? '');
	}

	async createTable(definition: TableDefinition, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(definition.name);
		const ddl = renderCreateTable({
			quote: Q,
			definition,
			database: this.targetDb(opts),
			driver: 'mysql'
		});
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async alterTable(name: string, operations: AlterOperation[], opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const fqt = qualified(Q, [this.targetDb(opts), name]);
		const parts: string[] = [];
		for (const op of operations) {
			switch (op.kind) {
				case 'add-column':
					assertSafeIdentifier(op.column.name);
					parts.push(`ADD COLUMN ${renderColumn({ quote: Q, column: op.column, driver: 'mysql' })}`);
					break;
				case 'drop-column':
					assertSafeIdentifier(op.name);
					parts.push(`DROP COLUMN ${Q(op.name)}`);
					break;
				case 'rename-column':
					assertSafeIdentifier(op.name);
					assertSafeIdentifier(op.newName);
					parts.push(`RENAME COLUMN ${Q(op.name)} TO ${Q(op.newName)}`);
					break;
				case 'modify-column':
					assertSafeIdentifier(op.column.name);
					parts.push(`MODIFY COLUMN ${renderColumn({ quote: Q, column: op.column, driver: 'mysql' })}`);
					break;
			}
		}
		const ddl = `ALTER TABLE ${fqt} ${parts.join(', ')}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropTable(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP TABLE ${qualified(Q, [this.targetDb(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async truncateTable(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `TRUNCATE TABLE ${qualified(Q, [this.targetDb(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async renameTable(name: string, newName: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const db = this.targetDb(opts);
		const ddl = `RENAME TABLE ${qualified(Q, [db, name])} TO ${qualified(Q, [db, newName])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async createIndex(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(def.name);
		def.columns.forEach(assertSafeIdentifier);
		const ddl = renderCreateIndex({ quote: Q, tableName, def, database: this.targetDb(opts) });
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropIndex(tableName: string, indexName: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(indexName);
		const ddl = `DROP INDEX ${Q(indexName)} ON ${qualified(Q, [this.targetDb(opts), tableName])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async createView(name: string, query: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `CREATE VIEW ${qualified(Q, [this.targetDb(opts), name])} AS ${query}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropView(name: string, opts?: SchemaOpts): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP VIEW ${qualified(Q, [this.targetDb(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	// ── Data CRUD ─────────────────────────────────────────────────────────

	async insertRow(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		Object.keys(row).forEach(assertSafeIdentifier);
		const { sql, params } = buildInsert({
			quote: Q,
			table,
			row,
			database: this.targetDb(opts),
			placeholder: () => '?'
		});
		return this.executeWrite(sql, params);
	}

	async updateRow(
		table: string,
		pk: Record<string, unknown>,
		changes: Record<string, unknown>,
		opts?: SchemaOpts
	): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		[...Object.keys(pk), ...Object.keys(changes)].forEach(assertSafeIdentifier);
		const { sql, params } = buildUpdate({
			quote: Q,
			table,
			pk,
			changes,
			database: this.targetDb(opts),
			placeholder: () => '?'
		});
		return this.executeWrite(sql, params);
	}

	async deleteRows(table: string, pks: Record<string, unknown>[], opts?: SchemaOpts): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		if (pks.length > 0) Object.keys(pks[0]).forEach(assertSafeIdentifier);
		const { sql, params } = buildDelete({
			quote: Q,
			table,
			pks,
			database: this.targetDb(opts),
			placeholder: () => '?'
		});
		return this.executeWrite(sql, params);
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
