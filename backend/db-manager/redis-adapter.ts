/**
 * Redis Adapter
 * Uses ioredis.
 *
 * "Tables" = top-level key groups (prefix before first ':') or individual keys.
 * Browse mode  = shows keys and their types/values for the selected group.
 * Query mode   = executes Redis commands directly, e.g.:
 *   GET mykey
 *   HGETALL user:123
 *   SET counter 0
 *   KEYS user:*
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

async function createClient(config: DBConnectionConfig) {
	const { default: Redis } = await import('ioredis');
	const client = new Redis({
		host: config.host || 'localhost',
		port: config.port || 6379,
		password: config.password || undefined,
		db: config.database ? parseInt(config.database, 10) || 0 : 0,
		connectTimeout: 5000,
		lazyConnect: true
	});
	await client.connect();
	return client;
}

export class RedisAdapter {
	private config: DBConnectionConfig;

	constructor(config: DBConnectionConfig) {
		this.config = config;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			await client.ping();
			const info = await client.info('server');
			const versionMatch = info.match(/redis_version:([^\r\n]+)/);
			return {
				success: true,
				message: 'Connected successfully',
				version: versionMatch?.[1]?.trim(),
				latencyMs: Date.now() - start
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : 'Failed to connect' };
		} finally {
			client?.disconnect();
		}
	}

	/**
	 * List all key groups (prefix-based, before first ':').
	 * Returns up to 500 keys via SCAN.
	 */
	async listTables(): Promise<DBTable[]> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			const allKeys: string[] = [];
			let cursor = '0';
			do {
				const [newCursor, batch] = await client.scan(cursor, 'COUNT', 100);
				cursor = newCursor;
				allKeys.push(...batch);
				if (allKeys.length >= 500) break;
			} while (cursor !== '0');

			// Group by prefix (first segment before ':')
			const groups = new Map<string, number>();
			for (const key of allKeys) {
				const prefix = key.includes(':') ? key.split(':')[0] : '__keys__';
				groups.set(prefix, (groups.get(prefix) ?? 0) + 1);
			}

			if (groups.size === 0) {
				return [{ name: '__keys__', type: 'table', rowCount: 0 }];
			}

			return Array.from(groups.entries()).map(([name, count]) => ({
				name,
				type: 'table' as const,
				rowCount: count
			}));
		} finally {
			client?.disconnect();
		}
	}

	async getForeignKeys(_groupName: string): Promise<ForeignKeyDef[]> {
		return [];
	}

	async getGroupKeyCount(groupName: string): Promise<number> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			const pattern = groupName === '__keys__' ? '*' : `${groupName}:*`;
			let count = 0;
			let cursor = '0';
			do {
				const [newCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
				cursor = newCursor;
				count += batch.length;
			} while (cursor !== '0');
			return count;
		} catch {
			return 0;
		} finally {
			client?.disconnect();
		}
	}

	/** "Columns" for a key group = show key, type, ttl, size */
	async describeTable(_groupName: string): Promise<DBColumn[]> {
		return [
			{ name: 'key', type: 'string', nullable: false, primaryKey: true },
			{ name: 'type', type: 'string', nullable: false, primaryKey: false },
			{ name: 'ttl', type: 'integer', nullable: true, primaryKey: false },
			{ name: 'value_preview', type: 'string', nullable: true, primaryKey: false }
		];
	}

	/** Execute Redis commands (one per call) */
	async executeQuery(command: string): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			client = await createClient(this.config);
			const parts = command.trim().split(/\s+/);
			if (parts.length === 0 || !parts[0]) {
				return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0, error: 'Empty command' };
			}

			const cmd = parts[0].toUpperCase();
			const args = parts.slice(1);

			const result = await (client as any).call(cmd, ...args);
			const executionTimeMs = Date.now() - start;

			// Format result
			if (result === null) {
				return { columns: ['result'], rows: [{ result: '(nil)' }], rowCount: 1, executionTimeMs };
			}
			if (Array.isArray(result)) {
				const rows = result.map((v, i) => ({ index: i + 1, value: String(v ?? '(nil)') }));
				return { columns: ['index', 'value'], rows, rowCount: rows.length, executionTimeMs };
			}
			if (typeof result === 'object') {
				const rows = Object.entries(result).map(([k, v]) => ({ key: k, value: String(v) }));
				return { columns: ['key', 'value'], rows, rowCount: rows.length, executionTimeMs };
			}
			return { columns: ['result'], rows: [{ result: String(result) }], rowCount: 1, executionTimeMs };
		} catch (error) {
			debug.error('database', 'Redis command error:', error);
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Command failed' };
		} finally {
			client?.disconnect();
		}
	}

	/** Browse keys belonging to a group prefix */
	async getTableData(groupName: string, _schema?: string, limit = 100, offset = 0): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			client = await createClient(this.config);
			const pattern = groupName === '__keys__' ? '*' : `${groupName}:*`;
			const allKeys: string[] = [];
			let cursor = '0';
			do {
				const [newCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
				cursor = newCursor;
				allKeys.push(...batch);
				if (allKeys.length >= offset + limit + 100) break;
			} while (cursor !== '0');

			const pageKeys = allKeys.slice(offset, offset + limit);

			const rows: Record<string, unknown>[] = [];
			for (const key of pageKeys) {
				const [type, ttl] = await Promise.all([client.type(key), client.ttl(key)]);
				let preview = '';
				try {
					if (type === 'string') preview = (await client.get(key)) ?? '';
					else if (type === 'hash') preview = JSON.stringify(await client.hgetall(key));
					else if (type === 'list') preview = JSON.stringify(await client.lrange(key, 0, 4));
					else if (type === 'set') preview = JSON.stringify(await client.smembers(key));
					else if (type === 'zset') preview = JSON.stringify(await client.zrange(key, 0, 4));
				} catch {
					preview = '(error reading)';
				}
				if (preview.length > 120) preview = preview.slice(0, 117) + '...';
				rows.push({ key, type, ttl: ttl >= 0 ? ttl : '∞', value_preview: preview });
			}

			return {
				columns: ['key', 'type', 'ttl', 'value_preview'],
				rows,
				rowCount: rows.length,
				executionTimeMs: Date.now() - start
			};
		} catch (error) {
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Failed to load keys' };
		} finally {
			client?.disconnect();
		}
	}
}
