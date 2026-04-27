/**
 * db-client — schema introspection WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import type { DbClientSchemaNodeType } from '$shared/types/db-client';

const nodeTypeSchema = t.Union([
	t.Literal('database'),
	t.Literal('schema'),
	t.Literal('table'),
	t.Literal('view'),
	t.Literal('collection'),
	t.Literal('index'),
	t.Literal('key'),
	t.Literal('column')
]);

export const schemaHandler = createRouter()
	.http('db-client:list-databases', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }) }),
		response: t.Array(t.Any())
	}, async ({ data }) => {
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
	}, async ({ data }) => {
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
	}, async ({ data }) => {
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
	}, async ({ data }) => {
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
	});
