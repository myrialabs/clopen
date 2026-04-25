/**
 * SQLite adapter — bun:sqlite (native, ships SQLite 3.51.0 per PHASE 0).
 * Phase 1: connect / close / health / executeRead / executeWrite / explain.
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'os';
import { resolve } from 'path';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientQueryResult
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './types';

function expandHome(p: string): string {
	if (p === '~') return homedir();
	if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
	// Convenience: treat a leading "/" before a dotfile (e.g. "/.clopen-dev/app.db")
	// as home-relative — common typo for "~/.clopen-dev/app.db".
	if (p.startsWith('/.')) return resolve(homedir(), p.slice(1));
	return p;
}

export class SqliteAdapter implements DbClientDriverAdapter {
	readonly kind = 'sqlite' as const;

	private db: Database | null = null;
	private alive = false;

	async connect(conn: DbClientConnection): Promise<void> {
		const raw = (conn.database ?? '').trim();
		if (!raw) {
			throw new Error('SQLite requires a file path in the `database` field');
		}
		const path = expandHome(raw);
		this.db = new Database(path);
		// Smoke-test the file on connect so bad paths fail fast.
		this.db.query('SELECT 1').get();
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
		if (!this.db) {
			return {
				ok: false,
				latencyMs: null,
				serverVersion: null,
				sshOk: null,
				error: 'Not connected'
			};
		}
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

	async executeRead(q: string, params: unknown[] = []): Promise<DbClientQueryResult> {
		if (!this.db) throw new Error('SQLite not connected');
		const start = performance.now();
		const stmt = this.db.query(q);
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
		if (!this.db) throw new Error('SQLite not connected');
		const start = performance.now();
		const stmt = this.db.prepare(q);
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
}
