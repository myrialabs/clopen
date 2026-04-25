/**
 * PostgreSQL adapter — Bun.sql (postgres://) per PHASE 0 findings.
 * Phase 1: connect / close / health / executeRead / executeWrite / explain.
 */

import { SQL } from 'bun';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientQueryResult
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './types';
import { normalizeBunSqlResult } from './bun-sql-helpers';
import { debug } from '$shared/utils/logger';

export class PostgresAdapter implements DbClientDriverAdapter {
	readonly kind = 'postgres' as const;

	private sql: SQL | null = null;
	private alive = false;

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
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
		const url = `postgres://${auth}${host}:${port}${db}${qs ? `?${qs}` : ''}`;

		this.sql = new SQL(url);
		await this.sql.connect();
		this.alive = true;
	}

	async close(): Promise<void> {
		this.alive = false;
		if (!this.sql) return;
		try {
			await this.sql.close();
		} catch (err) {
			debug.warn('db-client', 'Postgres close error:', err);
		}
		this.sql = null;
	}

	isAlive(): boolean {
		return this.alive && this.sql !== null;
	}

	async health(): Promise<DbClientHealth> {
		if (!this.sql) {
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
			const rows = await this.sql.unsafe('SELECT version() AS version') as Array<{ version: string }>;
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

	async executeRead(q: string, params: unknown[] = []): Promise<DbClientQueryResult> {
		if (!this.sql) throw new Error('Postgres not connected');
		const start = performance.now();
		const raw = await this.sql.unsafe(q, params as never);
		return normalizeBunSqlResult(raw, Math.round(performance.now() - start));
	}

	async executeWrite(q: string, params: unknown[] = []): Promise<DbClientQueryResult> {
		return this.executeRead(q, params);
	}

	async explain(q: string): Promise<DbClientQueryResult> {
		return this.executeRead(`EXPLAIN ${q}`);
	}
}
