/**
 * SQLite adapter — bun:sqlite (native, ships SQLite 3.51.0 per PHASE 0).
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { resolve } from 'path';
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
	IndexDefinition,
	SchemaOpts,
	TableDefinition
} from './types';
import {
	assertSafeIdentifier,
	buildDelete,
	buildInsert,
	buildUpdate,
	quoteSqlite,
	renderColumn,
	renderCreateIndex,
	renderCreateTable
} from './sql-builders';

const Q = quoteSqlite;

function expandHome(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
	if (p.startsWith('/.')) return resolve(homedir(), p.slice(1));
	return p;
}

export class SqliteAdapter implements DbClientDriverAdapter {
	readonly kind = 'sqlite' as const;

	private db: Database | null = null;
	private alive = false;
	private version = '0.0.0';

	async connect(conn: DbClientConnection): Promise<void> {
		const raw = (conn.database ?? '').trim();
		if (!raw) throw new Error('SQLite requires a file path in the `database` field');
		const path = expandHome(raw);
		this.db = new Database(path);
		const v = this.db.query('SELECT sqlite_version() AS version').get() as { version: string };
		this.version = v.version;
		this.alive = true;
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.db) {
			this.db.close();
			this.db = null;
		}
	}

	isAlive(): boolean {
		return this.alive && this.db !== null;
	}

	async health(): Promise<DbClientHealth> {
		if (!this.db) return notConnected();
		const start = performance.now();
		try {
			const row = this.db.query('SELECT sqlite_version() AS version').get() as { version: string } | null;
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - start),
				serverVersion: row?.version ?? null,
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

	private requireDb(): Database {
		if (!this.db) throw new Error('SQLite not connected');
		return this.db;
	}

	private versionAtLeast(min: string): boolean {
		const split = (s: string): number[] => s.split('.').map(Number);
		const [a1, a2 = 0, a3 = 0] = split(this.version);
		const [b1, b2 = 0, b3 = 0] = split(min);
		if (a1 !== b1) return a1 > b1;
		if (a2 !== b2) return a2 > b2;
		return a3 >= b3;
	}

	async executeRead(q: string, params: unknown[] = []): Promise<DbClientQueryResult> {
		const db = this.requireDb();
		const start = performance.now();
		const stmt = db.query(q);
		const rows = (params.length > 0
			? stmt.all(...(params as never[]))
			: stmt.all()) as Array<Record<string, unknown>>;
		const durationMs = Math.round(performance.now() - start);
		const columns = rows.length > 0
			? Object.keys(rows[0]).map((name) => ({ name, type: null as string | null }))
			: [];
		return {
			columns,
			rows,
			rowCount: rows.length,
			affectedRows: null,
			durationMs,
			driverMeta: {}
		};
	}

	async executeWrite(q: string, params: unknown[] = []): Promise<DbClientQueryResult> {
		const db = this.requireDb();
		const start = performance.now();
		const stmt = db.prepare(q);
		const result = (params.length > 0
			? stmt.run(...(params as never[]))
			: stmt.run()) as { changes: number; lastInsertRowid: number | bigint };
		return {
			columns: [],
			rows: [],
			rowCount: 0,
			affectedRows: result.changes,
			durationMs: Math.round(performance.now() - start),
			driverMeta: { lastInsertRowid: result.lastInsertRowid?.toString() ?? null }
		};
	}

	async explain(q: string): Promise<DbClientQueryResult> {
		return this.executeRead(`EXPLAIN QUERY PLAN ${q}`);
	}

	// ── Overview ──────────────────────────────────────────────────────────

	async overview(): Promise<DbClientOverview> {
		const db = this.requireDb();
		const start = performance.now();
		const pageCount = (db.query('PRAGMA page_count').get() as { page_count?: number } | null)?.page_count ?? 0;
		const pageSize = (db.query('PRAGMA page_size').get() as { page_size?: number } | null)?.page_size ?? 0;
		const latencyMs = Math.round(performance.now() - start);
		const counts = db.query(
			"SELECT SUM(type = 'table') AS tables, SUM(type = 'view') AS views FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'"
		).get() as { tables: number | null; views: number | null } | null;
		return {
			serverVersion: this.version,
			latencyMs,
			sizeBytes: pageCount * pageSize,
			tableCount: counts?.tables ?? 0,
			viewCount: counts?.views ?? 0,
			extra: [{ label: 'File', value: db.filename || 'main' }]
		};
	}

	// ── Schema ────────────────────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		// SQLite has only the open file — surface it as a single virtual database.
		const filename = this.requireDb().filename;
		return [{ name: filename || 'main', type: 'database' as const }];
	}

	async listObjects(): Promise<DbClientSchemaNode[]> {
		const rows = this.requireDb().query(
			"SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
		).all() as Array<{ name: string; type: string }>;
		return rows.map((r) => ({
			name: r.name,
			type: r.type === 'view' ? 'view' as const : 'table' as const
		}));
	}

	async getObjectDetails(name: string): Promise<DbClientObjectDetails> {
		const db = this.requireDb();
		assertSafeIdentifier(name);

		const colRows = db.query(`PRAGMA table_info(${Q(name)})`).all() as Array<Record<string, unknown>>;
		const columns: DbClientObjectColumn[] = colRows.map((r) => ({
			name: String(r.name),
			type: String(r.type ?? ''),
			nullable: r.notnull === 0,
			default: r.dflt_value === null ? null : String(r.dflt_value),
			isPrimary: typeof r.pk === 'number' ? r.pk > 0 : Boolean(r.pk),
			isUnique: false
		}));

		const idxRows = db.query(`PRAGMA index_list(${Q(name)})`).all() as Array<Record<string, unknown>>;
		const indexes: DbClientObjectIndex[] = [];
		for (const r of idxRows) {
			const idxName = String(r.name);
			const cols = (db.query(`PRAGMA index_info(${Q(idxName)})`).all() as Array<{ name: string }>)
				.map((c) => c.name);
			indexes.push({
				name: idxName,
				columns: cols,
				unique: r.unique === 1
			});
			// Mark unique columns
			if (r.unique === 1 && cols.length === 1) {
				const col = columns.find((c) => c.name === cols[0]);
				if (col) col.isUnique = true;
			}
		}

		const fkRows = db.query(`PRAGMA foreign_key_list(${Q(name)})`).all() as Array<Record<string, unknown>>;
		const foreignKeys: DbClientObjectForeignKey[] = fkRows.map((r) => ({
			column: String(r.from),
			refTable: String(r.table),
			refColumn: String(r.to)
		}));

		return { name, type: 'table', columns, indexes, foreignKeys };
	}

	// ── Structure ─────────────────────────────────────────────────────────

	async createTable(definition: TableDefinition): Promise<string> {
		assertSafeIdentifier(definition.name);
		const ddl = renderCreateTable({ quote: Q, definition, driver: 'sqlite' });
		this.requireDb().run(ddl);
		return ddl;
	}

	async alterTable(name: string, operations: AlterOperation[]): Promise<string> {
		assertSafeIdentifier(name);
		const fqt = Q(name);
		const ddls: string[] = [];
		for (const op of operations) {
			switch (op.kind) {
				case 'add-column':
					assertSafeIdentifier(op.column.name);
					ddls.push(`ALTER TABLE ${fqt} ADD COLUMN ${renderColumn({ quote: Q, column: op.column, driver: 'sqlite' })}`);
					break;
				case 'drop-column':
					if (!this.versionAtLeast('3.35.0')) {
						throw new Error(`SQLite ${this.version} does not support DROP COLUMN (requires 3.35+)`);
					}
					assertSafeIdentifier(op.name);
					ddls.push(`ALTER TABLE ${fqt} DROP COLUMN ${Q(op.name)}`);
					break;
				case 'rename-column':
					if (!this.versionAtLeast('3.25.0')) {
						throw new Error(`SQLite ${this.version} does not support RENAME COLUMN (requires 3.25+)`);
					}
					assertSafeIdentifier(op.name);
					assertSafeIdentifier(op.newName);
					ddls.push(`ALTER TABLE ${fqt} RENAME COLUMN ${Q(op.name)} TO ${Q(op.newName)}`);
					break;
				case 'modify-column':
					throw new Error('SQLite does not support MODIFY COLUMN — recreate the table to change a column type');
			}
		}
		const db = this.requireDb();
		for (const ddl of ddls) db.run(ddl);
		return ddls.join('; ');
	}

	async dropTable(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP TABLE ${Q(name)}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async truncateTable(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DELETE FROM ${Q(name)}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async resetTable(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const db = this.requireDb();
		const ddl = `DELETE FROM ${Q(name)}`;
		db.run(ddl);
		// AUTOINCREMENT counters live in sqlite_sequence (absent if unused).
		db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(name);
		return `${ddl}; DELETE FROM sqlite_sequence WHERE name = '${name}'`;
	}

	async resetDatabase(): Promise<string> {
		const db = this.requireDb();
		const rows = db.query(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		).all() as Array<{ name: string }>;
		if (rows.length === 0) return '-- no tables to empty';
		rows.forEach((r) => assertSafeIdentifier(r.name));
		const statements = rows.map((r) => `DELETE FROM ${Q(r.name)}`);
		db.transaction(() => {
			for (const stmt of statements) db.run(stmt);
			db.run('DELETE FROM sqlite_sequence');
		})();
		return `${statements.join(';\n')};\nDELETE FROM sqlite_sequence`;
	}

	async duplicateTable(name: string, newName: string, opts?: { withData?: boolean }): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		// SQLite cannot copy constraints via DDL; CREATE … AS SELECT preserves
		// columns and (optionally) rows. Constraints/keys are not carried over.
		const where = opts?.withData ? '' : ' WHERE 0';
		const ddl = `CREATE TABLE ${Q(newName)} AS SELECT * FROM ${Q(name)}${where}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async getCreateStatement(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const row = this.requireDb()
			.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND sql IS NOT NULL")
			.get(name) as { sql: string } | null;
		return row?.sql ? `${row.sql};` : '';
	}

	async renameTable(name: string, newName: string): Promise<string> {
		assertSafeIdentifier(name);
		assertSafeIdentifier(newName);
		const ddl = `ALTER TABLE ${Q(name)} RENAME TO ${Q(newName)}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async createIndex(tableName: string, def: IndexDefinition): Promise<string> {
		assertSafeIdentifier(tableName);
		assertSafeIdentifier(def.name);
		def.columns.forEach(assertSafeIdentifier);
		const ddl = renderCreateIndex({ quote: Q, tableName, def });
		this.requireDb().run(ddl);
		return ddl;
	}

	async dropIndex(_tableName: string, indexName: string): Promise<string> {
		assertSafeIdentifier(indexName);
		const ddl = `DROP INDEX ${Q(indexName)}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async createView(name: string, query: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `CREATE VIEW ${Q(name)} AS ${query}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	async dropView(name: string): Promise<string> {
		assertSafeIdentifier(name);
		const ddl = `DROP VIEW ${Q(name)}`;
		this.requireDb().run(ddl);
		return ddl;
	}

	// ── Data CRUD ─────────────────────────────────────────────────────────

	async insertRow(table: string, row: Record<string, unknown>): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		Object.keys(row).forEach(assertSafeIdentifier);
		const { sql, params } = buildInsert({ quote: Q, table, row, placeholder: () => '?' });
		return this.executeWrite(sql, params);
	}

	async updateRow(
		table: string,
		pk: Record<string, unknown>,
		changes: Record<string, unknown>
	): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		[...Object.keys(pk), ...Object.keys(changes)].forEach(assertSafeIdentifier);
		const { sql, params } = buildUpdate({ quote: Q, table, pk, changes, placeholder: () => '?' });
		return this.executeWrite(sql, params);
	}

	async deleteRows(table: string, pks: Record<string, unknown>[]): Promise<DbClientQueryResult> {
		assertSafeIdentifier(table);
		if (pks.length > 0) Object.keys(pks[0]).forEach(assertSafeIdentifier);
		const { sql, params } = buildDelete({ quote: Q, table, pks, placeholder: () => '?' });
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

