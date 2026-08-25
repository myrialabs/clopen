/**
 * db-client — schema introspection WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import type { DbClientSchemaNodeType } from '$shared/types/db-client';
import { requireDbClientConnectionAccess } from './access';
import { debug } from '$shared/utils/logger';

const nodeTypeSchema = t.Union([
	t.Literal('database'),
	t.Literal('schema'),
	t.Literal('table'),
	t.Literal('view'),
	t.Literal('collection'),
	t.Literal('index'),
	t.Literal('key'),
	t.Literal('column'),
	t.Literal('function'),
	t.Literal('procedure')
]);

export const schemaHandler = createRouter()
	.http('db-client:overview', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.overview) throw new Error('Driver does not support overview');
		return adapter.overview({ database: data.database, schema: data.schema });
	})

	.http('db-client:list-databases', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }) }),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.listDatabases) return [];
		return adapter.listDatabases();
	})

	.http('db-client:list-schemas', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String())
		}),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.listSchemas) return [];
		return adapter.listSchemas(data.database);
	})

	.http('db-client:list-objects', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String())
		}),
		response: t.Array(t.Any())
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.listObjects) return [];
		return adapter.listObjects(data.database, data.schema);
	})

	.http('db-client:object-details', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			type: nodeTypeSchema
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.getObjectDetails) {
			throw new Error('Driver does not support object details');
		}
		return adapter.getObjectDetails(
			data.name,
			data.type as DbClientSchemaNodeType,
			data.database,
			data.schema
		);
	})

	.http('db-client:get-er-schema', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.listObjects || !adapter.getObjectDetails) {
			return { tables: [] };
		}
		const getDetails = adapter.getObjectDetails.bind(adapter);
		const objects = await adapter.listObjects(data.database, data.schema);
		const tableNodes = objects.filter(o => o.type === 'table');
		const tables: any[] = [];
		await Promise.all(tableNodes.map(async (node) => {
			try {
				const details = await getDetails(node.name, 'table', data.database, data.schema);
				tables.push({
					name: node.name,
					columns: details.columns?.map(c => ({
						name: c.name,
						type: c.type,
						isPrimary: c.isPrimary ?? false,
						isUnique: c.isUnique ?? false
					})) ?? [],
					foreignKeys: details.foreignKeys?.map(fk => ({
						column: fk.column,
						refTable: fk.refTable,
						refColumn: fk.refColumn
					})) ?? []
				});
			} catch (e) {
				debug.warn('db-client', `Failed to get ER schema details for table ${node.name}:`, e);
			}
		}));
		return { tables };
	});
