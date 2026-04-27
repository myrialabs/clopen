/**
 * Redis adapter — Bun.RedisClient per PHASE 0 findings.
 *
 * Query shape: command string `"GET foo"` or JSON command array
 * `["HSET", "k", "f", "v"]`.
 *
 * "Schema" introspection lists keys via SCAN (capped at 1000) and
 * exposes type/TTL on object details. Structure operations are
 * key-level (rename, expire, delete).
 */

import { RedisClient } from 'bun';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientObjectDetails,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './types';
import { debug } from '$shared/utils/logger';

const SCAN_CAP = 1000;

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
		if (!this.client) return notConnected();
		const start = performance.now();
		try {
			await this.client.send('PING', []);
			let serverVersion: string | null = null;
			try {
				const info = (await this.client.send('INFO', ['server'])) as string;
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

	private requireClient(): RedisClient {
		if (!this.client) throw new Error('Redis not connected');
		return this.client;
	}

	// ── Schema (key listing) ──────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		// Redis has 16 logical DBs by default — surface 0..15 as virtual entries.
		return Array.from({ length: 16 }, (_, i) => ({
			name: String(i),
			type: 'database' as const
		}));
	}

	async listObjects(): Promise<DbClientSchemaNode[]> {
		const client = this.requireClient();
		const keys: string[] = [];
		let cursor = '0';
		do {
			const reply = (await client.send('SCAN', [cursor, 'COUNT', '200'])) as [string, string[]];
			cursor = reply[0];
			for (const k of reply[1]) {
				keys.push(k);
				if (keys.length >= SCAN_CAP) break;
			}
		} while (cursor !== '0' && keys.length < SCAN_CAP);
		keys.sort();
		return keys.map((name) => ({ name, type: 'key' as const }));
	}

	async getObjectDetails(name: string, _type: DbClientSchemaNodeType): Promise<DbClientObjectDetails> {
		const client = this.requireClient();
		const [type, ttl] = await Promise.all([
			client.send('TYPE', [name]) as Promise<string>,
			client.send('TTL', [name]) as Promise<number>
		]);
		return {
			name,
			type: 'key',
			redisValueType: type,
			redisTtlSeconds: ttl < 0 ? null : ttl
		};
	}

	// ── Query execution ──────────────────────────────────────────────────

	async executeRead(q: string): Promise<DbClientQueryResult> {
		return this.runCommand(q);
	}

	async executeWrite(q: string): Promise<DbClientQueryResult> {
		return this.runCommand(q);
	}

	private async runCommand(q: string): Promise<DbClientQueryResult> {
		const { cmd, args } = parseRedisCommand(q);
		const client = this.requireClient();
		const start = performance.now();
		const reply = await client.send(cmd, args);
		const durationMs = Math.round(performance.now() - start);
		const rows = formatReply(reply);
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

	// ── "Structure" — key-level operations ───────────────────────────────

	async dropTable(name: string): Promise<string> {
		await this.requireClient().send('DEL', [name]);
		return `DEL ${name}`;
	}

	async renameTable(name: string, newName: string): Promise<string> {
		await this.requireClient().send('RENAME', [name, newName]);
		return `RENAME ${name} ${newName}`;
	}

	async deleteRows(table: string, _pks: Record<string, unknown>[]): Promise<DbClientQueryResult> {
		await this.requireClient().send('DEL', [table]);
		return {
			columns: [],
			rows: [],
			rowCount: 0,
			affectedRows: 1,
			durationMs: 0,
			driverMeta: {}
		};
	}
}

function parseRedisCommand(q: string): { cmd: string; args: string[] } {
	const trimmed = q.trim();
	if (trimmed.startsWith('[')) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed) && parsed.length > 0) {
				return {
					cmd: String(parsed[0]).toUpperCase(),
					args: parsed.slice(1).map((v) => String(v))
				};
			}
		} catch {
			// fall through to plain parsing
		}
	}
	// Naive whitespace tokenizer — quoted args supported.
	const tokens = tokenize(trimmed);
	if (tokens.length === 0) throw new Error('Empty Redis command');
	return { cmd: tokens[0].toUpperCase(), args: tokens.slice(1) };
}

function tokenize(s: string): string[] {
	const out: string[] = [];
	let buf = '';
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (quote) {
			if (ch === quote) {
				quote = null;
			} else if (ch === '\\' && i + 1 < s.length) {
				buf += s[++i];
			} else {
				buf += ch;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (/\s/.test(ch)) {
			if (buf) { out.push(buf); buf = ''; }
			continue;
		}
		buf += ch;
	}
	if (buf) out.push(buf);
	return out;
}

function formatReply(reply: unknown): Array<Record<string, unknown>> {
	if (reply === null || reply === undefined) {
		return [{ value: null }];
	}
	if (typeof reply === 'string' || typeof reply === 'number' || typeof reply === 'boolean') {
		return [{ value: reply }];
	}
	if (Array.isArray(reply)) {
		return reply.map((v, i) => ({ index: i, value: v }));
	}
	if (typeof reply === 'object') {
		// HGETALL etc. return null-prototype objects per Phase 0.
		return [{ ...(reply as Record<string, unknown>) }];
	}
	return [{ value: String(reply) }];
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
