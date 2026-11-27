/**
 * Databases from the DB client: a database's whole schema, or one table.
 *
 * Browsed the way the DB client's sidebar is: a connection holds databases, a
 * database holds schemas (on drivers that have them), and those hold the
 * tables. A server-level connection usually lands on a home database with no
 * tables of its own, so stopping at the connection showed nothing.
 *
 * Listing connections is a read of Clopen's own table; opening one connects
 * to it (the same pooled connection the DB client uses), so the picker only
 * does that when a connection is opened. Query results are attached from the
 * DB client itself, where they are on screen.
 */

import type { MentionCandidate } from '$shared/types/mentions';
import type { DbClientDriverAdapter } from '$backend/db-client/drivers/types';
import type { DbClientObjectDetails, DbClientSchemaNode, DbClientSchemaNodeType } from '$shared/types/db-client';
import { buildContextDocument, type ContextSection } from '$shared/utils/context-document';
import { dbClientConnectionQueries } from '$backend/database/queries';
import { connectionManager } from '$backend/db-client/connection-manager';
import { rank, within } from '../shared';
import { refOptional, refString, type MentionSource } from '../types';

const CATEGORY = 'databases';
const PREFIX = 'database:';
/** A schema snapshot describes at most this many tables. */
const MAX_TABLES = 300;
/** Schemas looked into when a database is opened. */
const MAX_SCHEMAS = 30;
const LIST_BUDGET_MS = 10_000;

const TABLE_TYPES = new Set<DbClientSchemaNodeType>(['table', 'view', 'collection', 'key']);
/** The server's own bookkeeping, listed after the user's databases. */
const SYSTEM_DATABASES = new Set(['information_schema', 'mysql', 'performance_schema', 'sys', 'admin', 'local', 'config', 'master', 'model', 'msdb', 'tempdb']);

/** Where a list is: a connection, one of its databases, one schema in it. */
interface Place {
	connectionId: string;
	database?: string;
}

function encodePlace(place: Place): string {
	return `${PREFIX}${[place.connectionId, place.database].filter((part) => part !== undefined).map(encodeURIComponent).join('/')}`;
}

function decodePlace(category: string): Place {
	const [connectionId, database] = category.slice(PREFIX.length).split('/').map(decodeURIComponent);
	return { connectionId, ...(database !== undefined && { database }) };
}

function connectionRow(connection: { id: string; name: string; driver: string; database: string | null; host: string | null }): MentionCandidate {
	return {
		key: `db-connection:${connection.id}`,
		kind: 'db-connection',
		group: 'Databases',
		label: connection.name,
		detail: [connection.driver, connection.host, connection.database].filter(Boolean).join(' · ') || connection.driver,
		icon: 'lucide:database',
		ref: { connectionId: connection.id },
		browse: encodePlace({ connectionId: connection.id })
	};
}

/** The databases of a connection; empty when the driver has one database only. */
async function databasesOf(adapter: DbClientDriverAdapter): Promise<DbClientSchemaNode[]> {
	if (!adapter.listDatabases) return [];
	return within(adapter.listDatabases(), LIST_BUDGET_MS, []);
}

/** Every table-like object of a database, across its schemas, with the schema it is in. */
async function objectsOf(adapter: DbClientDriverAdapter, database: string | undefined): Promise<Array<DbClientSchemaNode & { schema?: string }>> {
	const schemas = adapter.listSchemas ? (await within(adapter.listSchemas(database), LIST_BUDGET_MS, [])).slice(0, MAX_SCHEMAS) : [];
	if (schemas.length === 0) {
		const objects = adapter.listObjects ? await within(adapter.listObjects(database), LIST_BUDGET_MS, []) : [];
		return objects.filter((object) => TABLE_TYPES.has(object.type));
	}
	const all: Array<DbClientSchemaNode & { schema?: string }> = [];
	for (const schema of schemas) {
		const objects = adapter.listObjects ? await within(adapter.listObjects(database, schema.name), LIST_BUDGET_MS, []) : [];
		for (const object of objects) if (TABLE_TYPES.has(object.type)) all.push({ ...object, schema: schema.name });
	}
	return all;
}

function describeColumns(details: DbClientObjectDetails): string {
	const lines: string[] = [];
	for (const column of details.columns ?? []) {
		const flags = [column.isPrimary && 'primary key', column.isUnique && 'unique', !column.nullable && 'not null', column.default !== null && `default ${column.default}`]
			.filter(Boolean)
			.join(', ');
		lines.push(`- ${column.name}: ${column.type}${flags ? ` (${flags})` : ''}`);
	}
	for (const key of details.foreignKeys ?? []) lines.push(`- ${key.column} → ${key.refTable}.${key.refColumn}`);
	for (const field of details.mongoFieldStats ?? []) lines.push(`- ${field.field}: ${field.types.join(' | ')}`);
	return lines.join('\n');
}

function plural(count: number, noun: string): string {
	return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

export const databaseSource: MentionSource = {
	kinds: ['db-connection', 'db-table'],

	categories: () =>
		dbClientConnectionQueries.listRedacted().length
			? [{ id: CATEGORY, label: 'Databases', detail: 'Schemas and tables from the DB client', icon: 'lucide:database', group: 'Data' }]
			: [],

	async list(_ctx, request) {
		const connections = () => dbClientConnectionQueries.listRedacted();
		if (request.category === CATEGORY) return rank(connections().map(connectionRow), request.query, (row) => [row.label, row.detail], request.limit);

		if (request.category?.startsWith(PREFIX)) {
			const place = decodePlace(request.category);
			const connection = dbClientConnectionQueries.require(place.connectionId);
			const adapter = await connectionManager.get(place.connectionId);

			// A connection: its databases, when it has more than the one it is on.
			if (place.database === undefined) {
				const databases = await databasesOf(adapter);
				if (databases.length > 1 || (databases.length === 1 && !connection.database)) {
					const ordered = [...databases].sort((a, b) => Number(SYSTEM_DATABASES.has(a.name)) - Number(SYSTEM_DATABASES.has(b.name)));
					const rows = ordered.map((database): MentionCandidate => ({
						key: `db-database:${connection.id}:${database.name}`,
						kind: 'db-connection',
						group: connection.name,
						label: database.name,
						detail: database.name === connection.database ? 'Database · the connection’s default' : SYSTEM_DATABASES.has(database.name) ? 'System database' : 'Database',
						icon: 'lucide:database',
						ref: { connectionId: connection.id, database: database.name },
						browse: encodePlace({ connectionId: connection.id, database: database.name })
					}));
					return rank(rows, request.query, (row) => [row.label], request.limit);
				}
			}

			// A database: its schema as a whole, then every table in it.
			const database = place.database ?? connection.database ?? undefined;
			const objects = await objectsOf(adapter, database);
			const schemas = new Set(objects.map((object) => object.schema).filter(Boolean));
			// A SQLite "database" is a file path; the connection's name reads better.
			const where = place.database ?? connection.name;
			const whole: MentionCandidate = {
				key: `db-connection:${connection.id}:${database ?? ''}:all`, kind: 'db-connection', group: where,
				label: `Whole schema of ${where}`, detail: objects.length ? plural(objects.length, 'table') : 'No tables found',
				icon: 'lucide:database', ref: { connectionId: connection.id, ...(database && { database }) }
			};
			const rows = objects.map((object): MentionCandidate => ({
				key: `db-table:${connection.id}:${database ?? ''}:${object.schema ?? ''}:${object.name}`,
				kind: 'db-table',
				group: where,
				label: schemas.size > 1 && object.schema ? `${object.schema}.${object.name}` : object.name,
				detail: [object.type, object.schema && `schema ${object.schema}`].filter(Boolean).join(' · '),
				icon: 'lucide:table',
				ref: { connectionId: connection.id, name: object.name, type: object.type, ...(database && { database }), ...(object.schema && { schema: object.schema }) }
			}));
			return [...(request.query.trim() ? [] : [whole]), ...rank(rows, request.query, (row) => [row.label], request.limit)];
		}

		if (request.category || !request.query.trim()) return [];
		return rank(connections().map(connectionRow), request.query, (row) => [row.label], 2);
	},

	async capture(_ctx, kind, ref) {
		const connectionId = refString(ref, 'connectionId');
		const connection = dbClientConnectionQueries.require(connectionId);
		const adapter = await connectionManager.get(connectionId);
		const database = refOptional(ref, 'database') ?? connection.database ?? undefined;
		const schema = refOptional(ref, 'schema');
		const facts: Array<[string, string | null | undefined]> = [['Connection', connection.name], ['Driver', connection.driver], ['Database', database], ['Schema', schema]];

		if (kind === 'db-table') {
			const name = refString(ref, 'name');
			const type = (refOptional(ref, 'type') ?? 'table') as DbClientSchemaNodeType;
			const details = adapter.getObjectDetails ? await adapter.getObjectDetails(name, type, database, schema) : null;
			let ddl = details?.ddl ?? null;
			if (!ddl && adapter.getCreateStatement) ddl = await adapter.getCreateStatement(name, type, { database, schema }).catch(() => null);
			const indexes = (details?.indexes ?? []).map((index) => `- ${index.name}${index.unique ? ' (unique)' : ''}: ${index.columns.join(', ')}`).join('\n');
			const sections: ContextSection[] = [];
			if (details) sections.push({ title: 'Columns', body: describeColumns(details) || '(none reported)' });
			if (indexes) sections.push({ title: 'Indexes', body: indexes });
			if (ddl) sections.push({ title: 'Definition', body: ddl, fence: 'sql' });
			return {
				documents: [buildContextDocument({
					kind, label: schema ? `${schema}.${name}` : name, detail: `${type} in ${refOptional(ref, 'database') ?? connection.name}`,
					facts: [...facts, ['Rows', details?.rowCount?.toLocaleString('en-US') ?? null]], sections
				})]
			};
		}

		const objects = (await objectsOf(adapter, database)).slice(0, MAX_TABLES);
		const sections: ContextSection[] = [];
		for (const object of objects) {
			const title = `${object.schema ? `${object.schema}.` : ''}${object.name} (${object.type})`;
			try {
				const details = adapter.getObjectDetails ? await within(adapter.getObjectDetails(object.name, object.type, database, object.schema), 5000, null) : null;
				sections.push({ title, body: details ? describeColumns(details) || '(no columns reported)' : '(details unavailable)' });
			} catch {
				sections.push({ title, body: '(details unavailable)' });
			}
		}
		return {
			documents: [buildContextDocument({
				kind: 'db-connection', label: refOptional(ref, 'database') ?? connection.name, detail: plural(objects.length, 'table'),
				facts: [...facts, ...(objects.length >= MAX_TABLES ? [['Shown', `first ${MAX_TABLES}`] as [string, string]] : [])],
				sections: sections.length ? sections : [{ body: 'No tables found in this database.' }]
			})]
		};
	}
};
