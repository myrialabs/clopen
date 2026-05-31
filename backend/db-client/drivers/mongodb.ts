/**
 * MongoDB adapter — `mongodb` v7.x per PHASE 0 findings.
 *
 * Query shape: JSON command `{ collection, op, args }` where `op` is one
 * of `find | findOne | aggregate | insertOne | insertMany | updateOne |
 * updateMany | deleteOne | deleteMany | countDocuments | distinct`.
 */

import { MongoClient, type Db, type Document, ObjectId } from 'mongodb';
import type {
	DbClientConnection,
	DbClientHealth,
	DbClientObjectDetails,
	DbClientOverview,
	DbClientQueryResult,
	DbClientSchemaNode,
	DbClientSchemaNodeType
} from '$shared/types/db-client';
import type { DbClientDriverAdapter, IndexDefinition, SchemaOpts, TableDefinition } from './types';
import { debug } from '$shared/utils/logger';

interface MongoCommand {
	collection: string;
	op: string;
	args?: unknown[];
}

const READ_OPS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'estimatedDocumentCount']);

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
		if (!this.client) return notConnected();
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

	private requireClient(): MongoClient {
		if (!this.client) throw new Error('Mongo not connected');
		return this.client;
	}

	private targetDb(opts?: SchemaOpts): string {
		const target = opts?.database || this.defaultDb;
		if (!target) throw new Error('Mongo: no database selected');
		return target;
	}

	private getDb(opts?: SchemaOpts): Db {
		return this.requireClient().db(this.targetDb(opts));
	}

	// ── Overview ──────────────────────────────────────────────────────────

	async overview(opts?: SchemaOpts): Promise<DbClientOverview> {
		const client = this.requireClient();
		const start = performance.now();
		const info = await client.db('admin').command({ buildInfo: 1 }) as { version?: string };
		const latencyMs = Math.round(performance.now() - start);
		const db = this.getDb(opts);
		const stats = await db.command({ dbStats: 1 }) as { dataSize?: number; collections?: number; objects?: number };
		return {
			serverVersion: info.version ?? null,
			latencyMs,
			sizeBytes: typeof stats.dataSize === 'number' ? stats.dataSize : null,
			tableCount: typeof stats.collections === 'number' ? stats.collections : null,
			viewCount: null,
			extra: [
				{ label: 'Database', value: this.targetDb(opts) },
				...(typeof stats.objects === 'number' ? [{ label: 'Documents', value: String(stats.objects) }] : [])
			]
		};
	}

	// ── Schema ────────────────────────────────────────────────────────────

	async listDatabases(): Promise<DbClientSchemaNode[]> {
		const adminDb = this.requireClient().db('admin');
		const result = await adminDb.admin().listDatabases();
		return result.databases.map((d) => ({
			name: d.name,
			type: 'database' as const,
			meta: typeof d.sizeOnDisk === 'number' ? { sizeOnDisk: d.sizeOnDisk } : undefined
		}));
	}

	async listObjects(database?: string): Promise<DbClientSchemaNode[]> {
		const db = this.getDb({ database });
		const collections = await db.listCollections({}, { nameOnly: true }).toArray();
		return collections.map((c) => ({ name: c.name, type: 'collection' as const }));
	}

	async getObjectDetails(
		name: string,
		_type: DbClientSchemaNodeType,
		database?: string
	): Promise<DbClientObjectDetails> {
		const db = this.getDb({ database });
		const collection = db.collection(name);

		const [indexes, sample, count] = await Promise.all([
			collection.indexes(),
			collection.find({}, { limit: 100 }).toArray() as Promise<Document[]>,
			collection.countDocuments()
		]);

		const fieldStats = computeFieldStats(sample);

		return {
			name,
			type: 'collection',
			columns: [{ name: '_id', type: 'ObjectId', nullable: false, default: null, isPrimary: true, isUnique: true }],
			indexes: indexes.map((i) => ({
				name: String(i.name),
				columns: Object.keys(i.key ?? {}),
				unique: Boolean(i.unique)
			})),
			rowCount: count,
			mongoFieldStats: fieldStats
		};
	}

	// ── Query execution (JSON command shape) ─────────────────────────────

	async executeRead(q: string, _params: unknown[] = [], opts?: { database?: string }): Promise<DbClientQueryResult> {
		const cmd = parseCommand(q);
		if (!READ_OPS.has(cmd.op)) {
			throw new Error(`Mongo executeRead got non-read op: ${cmd.op}`);
		}
		return this.runCommand(cmd, opts);
	}

	async executeWrite(q: string, _params: unknown[] = [], opts?: { database?: string }): Promise<DbClientQueryResult> {
		const cmd = parseCommand(q);
		return this.runCommand(cmd, opts);
	}

	private async runCommand(cmd: MongoCommand, opts?: { database?: string }): Promise<DbClientQueryResult> {
		const db = this.getDb({ database: opts?.database });
		const collection = db.collection(cmd.collection);
		const args = (cmd.args ?? []).map(reviveBson);
		const start = performance.now();

		const fn = (collection as unknown as Record<string, unknown>)[cmd.op];
		if (typeof fn !== 'function') {
			throw new Error(`Unknown Mongo op: ${cmd.op}`);
		}

		// Cursor-returning ops need toArray; others return promises directly.
		let raw: unknown;
		if (cmd.op === 'find' || cmd.op === 'aggregate') {
			const cursor = fn.apply(collection, args);
			raw = await cursor.toArray();
		} else {
			raw = await fn.apply(collection, args);
		}

		const durationMs = Math.round(performance.now() - start);
		const rows = Array.isArray(raw)
			? (raw as Array<Record<string, unknown>>)
			: [{ result: raw }];

		const columns = rows.length > 0
			? Object.keys(rows[0]).map((name) => ({ name, type: null as string | null }))
			: [];

		// affected/insert metadata for write ops
		const meta: Record<string, unknown> = {};
		if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
			const r = raw as Record<string, unknown>;
			for (const k of ['acknowledged', 'modifiedCount', 'matchedCount', 'deletedCount', 'insertedCount', 'insertedId', 'upsertedId', 'upsertedCount']) {
				if (k in r) meta[k] = r[k];
			}
		}
		const affected = pickNumber(meta.modifiedCount) ?? pickNumber(meta.deletedCount) ?? pickNumber(meta.insertedCount);

		return {
			columns,
			rows,
			rowCount: rows.length,
			affectedRows: affected ?? null,
			durationMs,
			driverMeta: meta
		};
	}

	// ── Structure ─────────────────────────────────────────────────────────

	async createTable(definition: TableDefinition, opts?: SchemaOpts): Promise<string> {
		await this.getDb(opts).createCollection(definition.name);
		return `db.createCollection('${definition.name}')`;
	}

	async dropTable(name: string, opts?: SchemaOpts): Promise<string> {
		await this.getDb(opts).collection(name).drop();
		return `db.${name}.drop()`;
	}

	async dropDatabase(name: string): Promise<string> {
		await this.requireClient().db(name).dropDatabase();
		if (this.defaultDb === name) this.defaultDb = null;
		return `db.getSiblingDB('${name}').dropDatabase()`;
	}

	async resetDatabase(opts?: SchemaOpts): Promise<string> {
		const db = this.getDb(opts);
		const collections = await db.listCollections({}, { nameOnly: true }).toArray();
		if (collections.length === 0) return '// no collections to empty';
		for (const c of collections) await db.collection(c.name).deleteMany({});
		return collections.map((c) => `db.${c.name}.deleteMany({})`).join('\n');
	}

	async truncateTable(name: string, opts?: SchemaOpts): Promise<string> {
		await this.getDb(opts).collection(name).deleteMany({});
		return `db.${name}.deleteMany({})`;
	}

	async resetTable(name: string, opts?: SchemaOpts): Promise<string> {
		// MongoDB has no sequence counter; reset is equivalent to emptying.
		return this.truncateTable(name, opts);
	}

	async duplicateTable(name: string, newName: string, opts?: (SchemaOpts & { withData?: boolean })): Promise<string> {
		const db = this.getDb(opts);
		if (opts?.withData) {
			await db.collection(name).aggregate([{ $match: {} }, { $out: newName }]).toArray();
			return `db.${name}.aggregate([{ $match: {} }, { $out: '${newName}' }])`;
		}
		await db.createCollection(newName);
		return `db.createCollection('${newName}')`;
	}

	async renameTable(name: string, newName: string, opts?: SchemaOpts): Promise<string> {
		await this.getDb(opts).renameCollection(name, newName);
		return `db.${name}.renameCollection('${newName}')`;
	}

	async createIndex(tableName: string, def: IndexDefinition, opts?: SchemaOpts): Promise<string> {
		const keys: Record<string, 1> = {};
		for (const c of def.columns) keys[c] = 1;
		await this.getDb(opts).collection(tableName).createIndex(keys, {
			name: def.name,
			unique: def.unique ?? false
		});
		return `db.${tableName}.createIndex(${JSON.stringify(keys)}, { name: '${def.name}', unique: ${def.unique ?? false} })`;
	}

	async dropIndex(tableName: string, indexName: string, opts?: SchemaOpts): Promise<string> {
		await this.getDb(opts).collection(tableName).dropIndex(indexName);
		return `db.${tableName}.dropIndex('${indexName}')`;
	}

	// ── Data CRUD ─────────────────────────────────────────────────────────

	async insertRow(table: string, row: Record<string, unknown>, opts?: SchemaOpts): Promise<DbClientQueryResult> {
		return this.runCommand({ collection: table, op: 'insertOne', args: [row] }, opts);
	}

	async updateRow(
		table: string,
		pk: Record<string, unknown>,
		changes: Record<string, unknown>,
		opts?: SchemaOpts
	): Promise<DbClientQueryResult> {
		return this.runCommand({ collection: table, op: 'updateOne', args: [pk, { $set: changes }] }, opts);
	}

	async deleteRows(
		table: string,
		pks: Record<string, unknown>[],
		opts?: SchemaOpts
	): Promise<DbClientQueryResult> {
		if (pks.length === 0) {
			throw new Error('deleteRows requires at least one row');
		}
		const filter = pks.length === 1 ? pks[0] : { $or: pks };
		return this.runCommand({ collection: table, op: 'deleteMany', args: [filter] }, opts);
	}
}

function parseCommand(q: string): MongoCommand {
	let parsed: unknown;
	try {
		parsed = JSON.parse(q);
	} catch (err) {
		throw new Error(`Mongo command must be valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('Mongo command must be a JSON object');
	}
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.collection !== 'string' || typeof obj.op !== 'string') {
		throw new Error('Mongo command requires `collection` and `op` fields');
	}
	const args = Array.isArray(obj.args) ? obj.args : [];
	return { collection: obj.collection, op: obj.op, args };
}

function reviveBson(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(reviveBson);
	const obj = value as Record<string, unknown>;
	// `{ "$oid": "..." }` → ObjectId
	if (typeof obj.$oid === 'string' && Object.keys(obj).length === 1) {
		return new ObjectId(obj.$oid);
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj)) out[k] = reviveBson(v);
	return out;
}

function pickNumber(value: unknown): number | null {
	return typeof value === 'number' ? value : null;
}

function computeFieldStats(docs: Document[]): Array<{ field: string; types: string[]; sampleCount: number }> {
	const map = new Map<string, { types: Set<string>; count: number }>();
	for (const doc of docs) {
		for (const [key, val] of Object.entries(doc)) {
			const entry = map.get(key) ?? { types: new Set(), count: 0 };
			entry.types.add(detectType(val));
			entry.count += 1;
			map.set(key, entry);
		}
	}
	return [...map.entries()].map(([field, { types, count }]) => ({
		field,
		types: [...types],
		sampleCount: count
	}));
}

function detectType(val: unknown): string {
	if (val === null) return 'null';
	if (Array.isArray(val)) return 'array';
	if (val instanceof Date) return 'date';
	if (val instanceof ObjectId) return 'objectId';
	return typeof val;
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
