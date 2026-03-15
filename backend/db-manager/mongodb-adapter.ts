/**
 * MongoDB Adapter
 * Uses the official `mongodb` driver.
 */

import type {
	DBConnectionConfig,
	DBTable,
	DBColumn,
	DBQueryResult,
	DBConnectionTestResult,
	DBRowFilter
} from '$shared/types/db-manager';
import type { ForeignKeyDef } from '$shared/types/alter-table';
import { debug } from '$shared/utils/logger';

function buildUrl(config: DBConnectionConfig): string {
	const { host, port, database, username, password } = config;
	const user = username ? encodeURIComponent(username) : '';
	const pass = password ? `:${encodeURIComponent(password)}` : '';
	const auth = user ? `${user}${pass}@` : '';
	return `mongodb://${auth}${host || 'localhost'}:${port || 27017}/${database || ''}`;
}

async function createClient(config: DBConnectionConfig) {
	const { MongoClient } = await import('mongodb');
	const client = new MongoClient(buildUrl(config), { serverSelectionTimeoutMS: 5000 });
	await client.connect();
	return client;
}

/** Serialize MongoDB documents — converts ObjectId to string */
function serializeDocs(docs: Record<string, unknown>[]): Record<string, unknown>[] {
	return docs.map((doc) => {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(doc)) {
			out[k] = v && typeof (v as any).toString === 'function' && typeof v !== 'string'
				? (v as any).toString()
				: v;
		}
		return out;
	});
}

function filtersToMongoQuery(filters: DBRowFilter[]): Record<string, unknown> {
	if (!filters.length) return {};
	const conditions: Record<string, unknown> = {};
	for (const f of filters) {
		switch (f.operator) {
			case 'eq': conditions[f.column] = f.value; break;
			case 'neq': conditions[f.column] = { $ne: f.value }; break;
			case 'like': conditions[f.column] = { $regex: f.value ?? '', $options: 'i' }; break;
			case 'gt': conditions[f.column] = { $gt: f.value }; break;
			case 'lt': conditions[f.column] = { $lt: f.value }; break;
			case 'null': conditions[f.column] = null; break;
			case 'notnull': conditions[f.column] = { $ne: null }; break;
		}
	}
	return conditions;
}

export class MongoDBAdapter {
	private config: DBConnectionConfig;

	constructor(config: DBConnectionConfig) {
		this.config = config;
	}

	async testConnection(): Promise<DBConnectionTestResult> {
		const start = Date.now();
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			await client.db('admin').command({ ping: 1 });
			const info = await client.db('admin').command({ buildInfo: 1 });
			return {
				success: true,
				message: 'Connected successfully',
				version: info.version as string,
				latencyMs: Date.now() - start
			};
		} catch (error) {
			return { success: false, message: error instanceof Error ? error.message : 'Failed to connect' };
		} finally {
			await client?.close();
		}
	}

	async listTables(): Promise<DBTable[]> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const collections = await db.listCollections().toArray();
			return collections.map((c) => ({
				name: c.name,
				type: (c.type === 'view' ? 'view' : 'table') as 'table' | 'view'
			}));
		} finally {
			await client?.close();
		}
	}

	async describeTable(collectionName: string): Promise<DBColumn[]> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const docs = await db.collection(collectionName).find({}).limit(20).toArray();
			const fieldMap = new Map<string, string>();
			for (const doc of docs) {
				for (const [key, val] of Object.entries(doc)) {
					if (!fieldMap.has(key)) {
						let type: string = typeof val;
						if (val === null) type = 'null';
						else if (Array.isArray(val)) type = 'array';
						else if (val && typeof val === 'object' && (val as any)._bsontype) type = (val as any)._bsontype.toLowerCase();
						fieldMap.set(key, type);
					}
				}
			}
			return Array.from(fieldMap.entries()).map(([name, type]) => ({
				name,
				type,
				nullable: true,
				primaryKey: name === '_id'
			}));
		} finally {
			await client?.close();
		}
	}

	async getForeignKeys(_collectionName: string): Promise<ForeignKeyDef[]> {
		return [];
	}

	async getCollectionCount(collectionName: string, filters?: DBRowFilter[]): Promise<number> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const query = filters?.length ? filtersToMongoQuery(filters) : {};
			return await db.collection(collectionName).countDocuments(query);
		} catch {
			return 0;
		} finally {
			await client?.close();
		}
	}

	async executeQuery(query: string, activeTable?: string): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);

			let collectionName = activeTable ?? '';
			let filterStr = query.trim();

			const firstLine = filterStr.split('\n')[0].trim();
			if (firstLine.toLowerCase().startsWith('collection:')) {
				collectionName = firstLine.slice('collection:'.length).trim();
				filterStr = filterStr.split('\n').slice(1).join('\n').trim();
			}

			if (!collectionName) {
				return { columns: [], rows: [], rowCount: 0, executionTimeMs: 0, error: 'No collection specified. Use "collection:name" on the first line.' };
			}

			let docs: Record<string, unknown>[];

			if (filterStr.trimStart().startsWith('[')) {
				const pipeline = JSON.parse(filterStr);
				docs = await db.collection(collectionName).aggregate(pipeline).toArray() as Record<string, unknown>[];
			} else {
				const filter = filterStr ? JSON.parse(filterStr) : {};
				docs = await db.collection(collectionName).find(filter).limit(100).toArray() as Record<string, unknown>[];
			}

			const serialized = serializeDocs(docs);
			const columns = serialized.length > 0 ? Object.keys(serialized[0]) : [];
			return { columns, rows: serialized, rowCount: serialized.length, executionTimeMs: Date.now() - start };
		} catch (error) {
			debug.error('database', 'MongoDB query error:', error);
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Query failed' };
		} finally {
			await client?.close();
		}
	}

	async getTableData(collectionName: string, _schema?: string, limit = 100, offset = 0, filters?: DBRowFilter[]): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const query = filters?.length ? filtersToMongoQuery(filters) : {};
			const docs = await db.collection(collectionName).find(query).skip(offset).limit(limit).toArray() as Record<string, unknown>[];
			const serialized = serializeDocs(docs);
			const columns = serialized.length > 0 ? Object.keys(serialized[0]) : [];
			return { columns, rows: serialized, rowCount: serialized.length, executionTimeMs: Date.now() - start };
		} catch (error) {
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Failed to load data' };
		} finally {
			await client?.close();
		}
	}

	async insertDocument(collectionName: string, doc: Record<string, unknown>): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const result = await db.collection(collectionName).insertOne(doc);
			return {
				columns: ['insertedId'],
				rows: [{ insertedId: result.insertedId.toString() }],
				rowCount: 1,
				executionTimeMs: Date.now() - start,
				affectedRows: 1
			};
		} catch (error) {
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Insert failed' };
		} finally {
			await client?.close();
		}
	}

	async updateDocument(collectionName: string, id: string, data: Record<string, unknown>): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			const { ObjectId } = await import('mongodb');
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			// Remove _id from update data
			const { _id: _removed, ...updateData } = data;
			const filter = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { _id: id as any };
			const result = await db.collection(collectionName).updateOne(filter, { $set: updateData });
			return {
				columns: ['modifiedCount'],
				rows: [{ modifiedCount: result.modifiedCount }],
				rowCount: result.modifiedCount,
				executionTimeMs: Date.now() - start,
				affectedRows: result.modifiedCount
			};
		} catch (error) {
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Update failed' };
		} finally {
			await client?.close();
		}
	}

	async deleteDocuments(collectionName: string, ids: string[]): Promise<DBQueryResult> {
		let client: Awaited<ReturnType<typeof createClient>> | null = null;
		const start = Date.now();
		try {
			const { ObjectId } = await import('mongodb');
			client = await createClient(this.config);
			const db = client.db(this.config.database || undefined);
			const objectIds = ids.map((id) => ObjectId.isValid(id) ? new ObjectId(id) : id as any);
			const result = await db.collection(collectionName).deleteMany({ _id: { $in: objectIds } });
			return {
				columns: ['deletedCount'],
				rows: [{ deletedCount: result.deletedCount }],
				rowCount: result.deletedCount,
				executionTimeMs: Date.now() - start,
				affectedRows: result.deletedCount
			};
		} catch (error) {
			return { columns: [], rows: [], rowCount: 0, executionTimeMs: Date.now() - start, error: error instanceof Error ? error.message : 'Delete failed' };
		} finally {
			await client?.close();
		}
	}
}
