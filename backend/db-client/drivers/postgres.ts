/**
 * PostgreSQL adapter — Bun.sql (postgres://) per PHASE 0 findings.
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
	quotePg,
	renderColumn,
	renderCreateIndex,
	renderCreateTable
} from './sql-builders';
import { debug } from '$shared/utils/logger';

const Q = quotePg;
const PG_PLACEHOLDER = (i: number): string => `$${i + 1}`;

export class PostgresAdapter implements DbClientDriverAdapter {
	readonly kind = 'postgres' as const;

	private sql: SQL | null = null;
	private alive = false;
	// The database the active connection currently points at (switched by
	// reconnecting in ensureDatabase).
	private defaultDb: string | null = null;
	// The connection's home database — what we revert to when no specific
	// database is requested, so a connection-level overview doesn't keep
	// reporting the last-browsed database.
	private homeDb = 'postgres';
	// Whether the connection was created with a fixed database. `conn` itself is
	// rewritten when switching databases, so this stable flag is what tells us a
	// connection-level (cluster) overview is appropriate.
	private hasConfiguredDb = false;
	private defaultSchema: string | null = null;
	private conn: DbClientConnection | null = null;
	private tunnelPort: number | undefined = undefined;
	private ensureLock = Promise.resolve();

	private buildUrl(conn: DbClientConnection, tunnelPort?: number): string {
		const host = tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
		const port = tunnelPort ?? conn.port ?? 5432;
		const user = encodeURIComponent(conn.username ?? '');
		const pass = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
		const auth = user ? `${user}${pass}@` : '';
		const db = conn.database ? `/${encodeURIComponent(conn.database)}` : '/postgres';

		const params = new URLSearchParams();
		if (conn.sslMode && conn.sslMode !== 'disable') {
			params.set('sslmode', conn.sslMode);
		}
		const qs = params.toString();
		return `postgres://${auth}${host}:${port}${db}${qs ? `?${qs}` : ''}`;
	}

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
		const url = this.buildUrl(conn, tunnelPort);

		this.sql = new SQL(url);
		await this.sql.connect();
		this.hasConfiguredDb = !!conn.database;
		this.homeDb = conn.database || 'postgres';
		this.defaultDb = this.homeDb;
		this.defaultSchema = typeof conn.options?.schema === 'string' ? conn.options.schema : 'public';
		this.conn = conn;
		this.tunnelPort = tunnelPort;
		this.alive = true;
	}

	private async ensureDatabase(database?: string): Promise<void> {
		if (!this.conn) return;
		const target = database || this.homeDb;
		if (target === this.defaultDb) return;

		let release: () => void;
		const prev = this.ensureLock;
		this.ensureLock = new Promise<void>((resolve) => { release = resolve; });
		await prev;

		try {
			if (target === this.defaultDb) return;
			const newConn = { ...this.conn, database: target };
			const url = this.buildUrl(newConn, this.tunnelPort);
			const next = new SQL(url);
			await next.connect();
			const prevSql = this.sql;
			this.sql = next;
			this.defaultDb = target;
			this.conn = newConn;
			this.alive = true;
			if (prevSql) await prevSql.close().catch((err) => debug.warn('db-client', 'pg switch close error:', err));
		} finally {
			release!();
		}
	}

	async close(): Promise<void> {
		let release: () => void;
		const prev = this.ensureLock;
		this.ensureLock = new Promise<void>((resolve) => { release = resolve; });
		await prev;

		try {
			this.alive = false;
			this.conn = null;
			if (!this.sql) return;
			await this.sql.close().catch((err) => debug.warn('db-client', 'Postgres close error:', err));
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
			const rows = (await this.sql.unsafe('SELECT version() AS version')) as Array<{ version: string }>;
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
		if (!this.sql) throw new Error('Postgres not connected');
		return this.sql;
	}

	private targetSchema(opts?: SchemaOpts): string {
		return opts?.schema || this.defaultSchema || 'public';
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
		// Bun.sql reserves a single connection for the duration of `begin`, so
		// every statement below shares one transaction. Postgres wraps DDL in
		// the transaction too, so a mid-batch failure rolls everything back.
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
		await this.ensureDatabase(opts?.database);
		const sql = this.requireSql();
		const start = performance.now();
		const verRows = (await sql.unsafe('SELECT version() AS v')) as Array<{ v: string }>;
		const latencyMs = Math.round(performance.now() - start);

		// Connection level (no configured database, none in scope) → cluster-wide
		// stats rather than the home database's, so it never looks "stuck" on the
		// last-browsed database.
		if (!this.hasConfiguredDb && !opts?.database) {
			const rows = (await sql.unsafe(
				`SELECT COUNT(*) AS dbs, SUM(pg_database_size(datname)) AS size
				 FROM pg_database WHERE datistemplate = false`
			)) as Array<Record<string, unknown>>;
			const r = rows[0] ?? {};
			return {
				serverVersion: verRows[0]?.v ?? null,
				latencyMs,
				sizeBytes: r.size === null || r.size === undefined ? null : Number(r.size),
				tableCount: null,
				viewCount: null,
				extra: [{ label: 'Databases', value: String(r.dbs === null || r.dbs === undefined ? 0 : Number(r.dbs)) }]
			};
		}

		const schema = this.targetSchema(opts);
		const sizeRows = (await sql.unsafe('SELECT pg_database_size(current_database()) AS size')) as Array<{ size: unknown }>;
		const countRows = (await sql.unsafe(
			`SELECT
			   COUNT(*) FILTER (WHERE table_type = 'BASE TABLE') AS tables,
			   COUNT(*) FILTER (WHERE table_type = 'VIEW') AS views
			 FROM information_schema.tables WHERE table_schema = $1`,
			[schema] as never
		)) as Array<Record<string, unknown>>;
		const c = countRows[0] ?? {};
		return {
			serverVersion: verRows[0]?.v ?? null,
			latencyMs,
			sizeBytes: sizeRows[0]?.size === undefined ? null : Number(sizeRows[0].size),
			tableCount: c.tables === undefined ? null : Number(c.tables),
			viewCount: c.views === undefined ? null : Number(c.views),
			extra: [
				{ label: 'Database', value: this.defaultDb ?? 'postgres' },
				{ label: 'Schema', value: schema }
			]
		};
	}

	// ── Schema ────────────────────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		const rows = (await this.requireSql().unsafe(
			'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
		)) as Array<{ datname: string }>;
		return rows.map((r) => ({ name: r.datname, type: 'database' as const }));
	}

	async listSchemas(): Promise<DbClientSchemaNode[]> {
		const rows = (await this.requireSql().unsafe(
			`SELECT schema_name FROM information_schema.schemata
			 WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
			 ORDER BY schema_name`
		)) as Array<{ schema_name: string }>;
		return rows.map((r) => ({ name: r.schema_name, type: 'schema' as const }));
	}

	async listObjects(database?: string, schema?: string): Promise<DbClientSchemaNode[]> {
		await this.ensureDatabase(database);
		const target = this.targetSchema({ schema });
		const tables = (await this.requireSql().unsafe(
			`SELECT table_name, table_type FROM information_schema.tables
			 WHERE table_schema = $1 ORDER BY table_name`,
			[target] as never
		)) as Array<{ table_name: string; table_type: string }>;

		// Query pg_proc directly (not information_schema.routines) so we can filter
		// on prokind: keep plain functions ('f') and procedures ('p'), but exclude
		// aggregates ('a') and window functions ('w') — those (e.g. avg/sum) have no
		// pg_get_functiondef and would error when their DDL is opened.
		const routines = (await this.requireSql().unsafe(
			`SELECT p.proname AS routine_name, p.prokind
			 FROM pg_proc p
			 JOIN pg_namespace n ON p.pronamespace = n.oid
			 WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
			 ORDER BY p.proname`,
			[target] as never
		)) as Array<{ routine_name: string; prokind: string }>;

		const tableNodes = tables.map((r) => ({
			name: r.table_name,
			type: r.table_type === 'VIEW' ? ('view' as const) : ('table' as const)
		}));

		// Overloaded functions (e.g. the `citext` extension) appear once per
		// signature. Collapse to one node per name since the tree browses and
		// fetches routine details by name alone.
		const seenRoutines = new Set<string>();
		const routineNodes = routines
			.filter((r) => {
				const key = `${r.prokind}:${r.routine_name}`;
				if (seenRoutines.has(key)) return false;
				seenRoutines.add(key);
				return true;
			})
			.map((r) => ({
				name: r.routine_name,
				type: r.prokind === 'p' ? ('procedure' as const) : ('function' as const)
			}));

		return [...tableNodes, ...routineNodes];
	}

	async getObjectDetails(
		name: string,
		_type: DbClientSchemaNodeType,
		database?: string,
		schema?: string
	): Promise<DbClientObjectDetails> {
		await this.ensureDatabase(database);
		const target = this.targetSchema({ schema });
		const sql = this.requireSql();

		if (_type === 'function' || _type === 'procedure') {
			const routineRows = (await sql.unsafe(
				`SELECT pg_get_functiondef(p.oid) AS definition
				 FROM pg_proc p
				 JOIN pg_namespace n ON p.pronamespace = n.oid
				 WHERE n.nspname = $1 AND p.proname = $2`,
				[target, name] as never
			)) as Array<{ definition: string }>;
			
			const definition = routineRows[0]?.definition ?? '';
			return {
				name,
				type: _type,
				ddl: String(definition)
			};
		}

		const colRows = (await sql.unsafe(
			`SELECT c.column_name, c.data_type, c.udt_name, c.is_nullable, c.column_default,
			        EXISTS (
			          SELECT 1 FROM information_schema.key_column_usage kcu
			          JOIN information_schema.table_constraints tc
			            ON tc.constraint_name = kcu.constraint_name
			           AND tc.table_schema = kcu.table_schema
			          WHERE tc.constraint_type = 'PRIMARY KEY'
			            AND kcu.table_schema = c.table_schema
			            AND kcu.table_name = c.table_name
			            AND kcu.column_name = c.column_name
			        ) AS is_primary,
			        EXISTS (
			          SELECT 1 FROM information_schema.key_column_usage kcu
			          JOIN information_schema.table_constraints tc
			            ON tc.constraint_name = kcu.constraint_name
			           AND tc.table_schema = kcu.table_schema
			          WHERE tc.constraint_type = 'UNIQUE'
			            AND kcu.table_schema = c.table_schema
			            AND kcu.table_name = c.table_name
			            AND kcu.column_name = c.column_name
			        ) AS is_unique
			   FROM information_schema.columns c
			  WHERE c.table_schema = $1 AND c.table_name = $2
			  ORDER BY c.ordinal_position`,
			[target, name] as never
		)) as Array<Record<string, unknown>>;

		const columns: DbClientObjectColumn[] = colRows.map((r) => ({
			name: String(r.column_name),
			type: String(r.udt_name ?? r.data_type ?? ''),
			nullable: r.is_nullable === 'YES',
			default: r.column_default === null ? null : String(r.column_default),
			isPrimary: Boolean(r.is_primary),
			isUnique: Boolean(r.is_unique)
		}));

		const idxRows = (await sql.unsafe(
			`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2`,
			[target, name] as never
		)) as Array<{ indexname: string; indexdef: string }>;

		const indexes: DbClientObjectIndex[] = idxRows.map((r) => {
			const m = /\(([^)]+)\)/.exec(r.indexdef);
			const cols = m ? m[1].split(',').map((s) => s.trim().replace(/"/g, '')) : [];
			return {
				name: r.indexname,
				columns: cols,
				unique: /\bUNIQUE\b/i.test(r.indexdef)
			};
		});

		const fkRows = (await sql.unsafe(
			`SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column
			   FROM information_schema.table_constraints tc
			   JOIN information_schema.key_column_usage kcu
			     ON tc.constraint_name = kcu.constraint_name
			    AND tc.table_schema = kcu.table_schema
			   JOIN information_schema.constraint_column_usage ccu
			     ON ccu.constraint_name = tc.constraint_name
			    AND ccu.table_schema = tc.table_schema
			  WHERE tc.constraint_type = 'FOREIGN KEY'
			    AND tc.table_schema = $1
			    AND tc.table_name = $2`,
			[target, name] as never
		)) as Array<Record<string, unknown>>;

		const foreignKeys: DbClientObjectForeignKey[] = fkRows.map((r) => ({
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
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropDatabase(name: string): Promise<string> {
		assertSafeIdentifier(name);
		// Postgres refuses to drop the database the session is connected to —
		// hop to the maintenance database first when needed.
		if (this.defaultDb === name) await this.ensureDatabase('postgres');
		const ddl = `DROP DATABASE ${Q(name)}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async renameDatabase(name: string, newName: string): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		if (this.defaultDb === name) await this.ensureDatabase('postgres');
		const ddl = `ALTER DATABASE ${Q(name)} RENAME TO ${Q(newName)}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async resetDatabase(opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		const target = this.targetSchema(opts);
		const sql = this.requireSql();
		const rows = (await sql.unsafe(
			`SELECT table_name FROM information_schema.tables
			 WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
			[target] as never
		)) as Array<{ table_name: string }>;
		if (rows.length === 0) return '-- no tables to empty';
		rows.forEach((r) => assertSafeIdentifier(r.table_name));
		const list = rows.map((r) => qualified(Q, [target, r.table_name])).join(', ');
		const ddl = `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`;
		await sql.unsafe(ddl);
		return ddl;
	}

	async resetTable(name: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const ddl = `TRUNCATE TABLE ${qualified(Q, [this.targetSchema(opts), name])} RESTART IDENTITY`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async duplicateTable(name: string, newName: string, opts?: (SchemaOpts & { withData?: boolean })): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const schema = this.targetSchema(opts);
		const src = qualified(Q, [schema, name]);
		const dst = qualified(Q, [schema, newName]);
		const sql = this.requireSql();
		const create = `CREATE TABLE ${dst} (LIKE ${src} INCLUDING ALL)`;
		await sql.unsafe(create);
		const statements = [create];
		if (opts?.withData) {
			const copy = `INSERT INTO ${dst} SELECT * FROM ${src}`;
			await sql.unsafe(copy);
			statements.push(copy);
		}
		return statements.join(';\n');
	}

	async getCreateStatement(name: string, _type: DbClientSchemaNodeType, opts?: SchemaOpts): Promise<string> {
		// Postgres has no SHOW CREATE; reconstruct a best-effort CREATE TABLE.
		const details = await this.getObjectDetails(name, 'table', opts?.database, opts?.schema);
		const schema = this.targetSchema(opts);
		const detailColumns = details.columns ?? [];
		const cols = detailColumns.map((c) => {
			const parts = [Q(c.name), c.type];
			if (!c.nullable) parts.push('NOT NULL');
			if (c.default !== null && c.default !== undefined && c.default !== '') parts.push(`DEFAULT ${c.default}`);
			return `  ${parts.join(' ')}`;
		});
		const pk = detailColumns.filter((c) => c.isPrimary).map((c) => Q(c.name));
		if (pk.length > 0) cols.push(`  PRIMARY KEY (${pk.join(', ')})`);
		const lines = [`CREATE TABLE ${qualified(Q, [schema, name])} (`, cols.join(',\n'), ');'];
		return lines.join('\n');
	}

	async createTable(definition: TableDefinition, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(definition.name);
		const ddl = renderCreateTable({
			quote: Q,
			definition,
			schema: this.targetSchema(opts),
			driver: 'postgres'
		});
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async alterTable(name: string, operations: AlterOperation[], opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const fqt = qualified(Q, [this.targetSchema(opts), name]);
		const parts: string[] = [];
		for (const op of operations) {
			switch (op.kind) {
				case 'add-column':
					assertSafeIdentifier(op.column.name);
					parts.push(`ADD COLUMN ${renderColumn({ quote: Q, column: op.column, driver: 'postgres' })}`);
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
					parts.push(`ALTER COLUMN ${Q(op.column.name)} TYPE ${op.column.type}`);
					break;
			}
		}
		const ddl = `ALTER TABLE ${fqt} ${parts.join(', ')}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropTable(name: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const ddl = `DROP TABLE ${qualified(Q, [this.targetSchema(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async truncateTable(name: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const ddl = `TRUNCATE TABLE ${qualified(Q, [this.targetSchema(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async renameTable(name: string, newName: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const ddl = `ALTER TABLE ${qualified(Q, [this.targetSchema(opts), name])} RENAME TO ${Q(newName)}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async createIndex(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(def.name);
		def.columns.forEach(assertSafeIdentifier);
		const ddl = renderCreateIndex({ quote: Q, tableName, def, schema: this.targetSchema(opts) });
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropIndex(_tableName: string, indexName: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(indexName);
		const ddl = `DROP INDEX ${qualified(Q, [this.targetSchema(opts), indexName])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async createView(name: string, query: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const ddl = `CREATE VIEW ${qualified(Q, [this.targetSchema(opts), name])} AS ${query}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	async dropView(name: string, opts?: SchemaOpts): Promise<string> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(name);
		const ddl = `DROP VIEW ${qualified(Q, [this.targetSchema(opts), name])}`;
		await this.requireSql().unsafe(ddl);
		return ddl;
	}

	// ── Data CRUD ─────────────────────────────────────────────────────────

	async insertRow(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(table);
		Object.keys(row).forEach(assertSafeIdentifier);
		const { sql, params } = buildInsert({
			quote: Q,
			table,
			row,
			schema: this.targetSchema(opts),
			placeholder: PG_PLACEHOLDER
		});
		return this.executeWrite(sql, params);
	}

	async updateRow(
		table: string,
		pk: Record<string, unknown>,
		changes: Record<string, unknown>,
		opts?: SchemaOpts
	): Promise<DbClientQueryResult> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(table);
		[...Object.keys(pk), ...Object.keys(changes)].forEach(assertSafeIdentifier);
		const { sql, params } = buildUpdate({
			quote: Q,
			table,
			pk,
			changes,
			schema: this.targetSchema(opts),
			placeholder: PG_PLACEHOLDER
		});
		return this.executeWrite(sql, params);
	}

	async deleteRows(table: string, pks: Record<string, unknown>[], opts?: SchemaOpts): Promise<DbClientQueryResult> {
		await this.ensureDatabase(opts?.database);
		assertSafeIdentifier(table);
		if (pks.length > 0) Object.keys(pks[0]).forEach(assertSafeIdentifier);
		const { sql, params } = buildDelete({
			quote: Q,
			table,
			pks,
			schema: this.targetSchema(opts),
			placeholder: PG_PLACEHOLDER
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
