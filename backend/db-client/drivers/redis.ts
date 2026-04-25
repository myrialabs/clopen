/**
 * Redis adapter — Bun.RedisClient per PHASE 0 findings.
 * Phase 1: connect / close / health / PING.
 */

import { RedisClient } from 'bun';
import type {
	DbClientConnection,
	DbClientHealth
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './types';
import { debug } from '$shared/utils/logger';

export class RedisAdapter implements DbClientDriverAdapter {
	readonly kind = 'redis' as const;

	private client: RedisClient | null = null;
	private alive = false;

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
		const host = tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
		const port = tunnelPort ?? conn.port ?? 6379;
		const pass = conn.password ? `:${encodeURIComponent(conn.password)}@` : '';
		const dbIdx = conn.database && /^\d+$/.test(conn.database) ? `/${conn.database}` : '';

		const url = `redis://${pass}${host}:${port}${dbIdx}`;
		this.client = new RedisClient(url);
		await this.client.connect();
		this.alive = true;
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.client) {
			try {
				this.client.close();
			} catch (err) {
				debug.warn('db-client', 'Redis close error:', err);
			}
			this.client = null;
		}
	}

	isAlive(): boolean {
		return this.alive && this.client !== null;
	}

	async health(): Promise<DbClientHealth> {
		if (!this.client) {
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
			await this.client.send('PING', []);
			let serverVersion: string | null = null;
			try {
				const info = await this.client.send('INFO', ['server']) as string;
				const match = /redis_version:([^\r\n]+)/.exec(info ?? '');
				serverVersion = match?.[1]?.trim() ?? null;
			} catch {
				serverVersion = null;
			}
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - start),
				serverVersion,
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
}
