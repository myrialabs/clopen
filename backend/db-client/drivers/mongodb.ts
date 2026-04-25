/**
 * MongoDB adapter — `mongodb` v7.2.0 per PHASE 0 findings.
 *
 * Phase 1: connect / close / health / ping / listCollections.
 * `listCollections` here only powers the health view; full schema
 * introspection lands in Phase 2.
 */

import { MongoClient, type Db } from 'mongodb';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientSchemaNode
} from '$shared/types/db-client';
import type { DbClientDriverAdapter } from './types';
import { debug } from '$shared/utils/logger';

export class MongoDbAdapter implements DbClientDriverAdapter {
	readonly kind = 'mongodb' as const;

	private client: MongoClient | null = null;
	private defaultDb: string | null = null;
	private alive = false;

	async connect(conn: DbClientConnection, tunnelPort?: number): Promise<void> {
		const host = tunnelPort ? '127.0.0.1' : (conn.host ?? '127.0.0.1');
		const port = tunnelPort ?? conn.port ?? 27017;
		const user = conn.username ? encodeURIComponent(conn.username) : '';
		const pass = conn.password ? `:${encodeURIComponent(conn.password)}` : '';
		const auth = user ? `${user}${pass}@` : '';
		const dbPart = conn.database ? `/${encodeURIComponent(conn.database)}` : '';

		// PHASE 0 note: workspace `root` user requires `authSource=admin`.
		const params = new URLSearchParams();
		const optsAuthSource = typeof conn.options?.authSource === 'string' ? conn.options.authSource : null;
		if (user) {
			params.set('authSource', optsAuthSource ?? 'admin');
		}
		const qs = params.toString();
		const uri = `mongodb://${auth}${host}:${port}${dbPart}${qs ? `?${qs}` : ''}`;

		this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
		await this.client.connect();
		this.defaultDb = conn.database || null;
		this.alive = true;
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.client) {
			try {
				await this.client.close();
			} catch (err) {
				debug.warn('db-client', 'Mongo close error:', err);
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
			const adminDb = this.client.db('admin');
			const info = await adminDb.command({ buildInfo: 1 }) as { version?: string };
			return {
				ok: true,
				latencyMs: Math.round(performance.now() - start),
				serverVersion: info.version ?? null,
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

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		if (!this.client) throw new Error('Mongo not connected');
		const adminDb = this.client.db('admin');
		const result = await adminDb.admin().listDatabases();
		return result.databases.map((d) => ({
			name: d.name,
			type: 'database' as const,
			meta: typeof d.sizeOnDisk === 'number' ? { sizeOnDisk: d.sizeOnDisk } : undefined
		}));
	}

	async listObjects(database?: string): Promise<DbClientSchemaNode[]> {
		if (!this.client) throw new Error('Mongo not connected');
		const target = database ?? this.defaultDb;
		if (!target) throw new Error('Mongo: no database selected');
		const db: Db = this.client.db(target);
		const collections = await db.listCollections({}, { nameOnly: true }).toArray();
		return collections.map((c) => ({
			name: c.name,
			type: 'collection' as const
		}));
	}
}
