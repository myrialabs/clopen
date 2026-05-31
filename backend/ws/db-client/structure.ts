/**
 * db-client — structure (DDL) WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import type { AlterOperation, IndexDefinition, TableDefinition } from '../../db-client/drivers/types';
import type { DbClientSchemaNodeType } from '$shared/types/db-client';
import { requireDbClientConnectionAccess } from './access';

const columnDefinitionSchema = t.Object({
	name: t.String({ minLength: 1 }),
	type: t.String({ minLength: 1 }),
	nullable: t.Optional(t.Boolean()),
	default: t.Optional(t.Nullable(t.String())),
	primary: t.Optional(t.Boolean()),
	unique: t.Optional(t.Boolean()),
	autoIncrement: t.Optional(t.Boolean())
});

const tableDefinitionSchema = t.Object({
	name: t.String({ minLength: 1 }),
	columns: t.Array(columnDefinitionSchema),
	primaryKey: t.Optional(t.Array(t.String()))
});

const alterOpSchema = t.Union([
	t.Object({ kind: t.Literal('add-column'), column: columnDefinitionSchema }),
	t.Object({ kind: t.Literal('drop-column'), name: t.String() }),
	t.Object({ kind: t.Literal('rename-column'), name: t.String(), newName: t.String() }),
	t.Object({ kind: t.Literal('modify-column'), column: columnDefinitionSchema })
]);

const indexDefinitionSchema = t.Object({
	name: t.String({ minLength: 1 }),
	columns: t.Array(t.String()),
	unique: t.Optional(t.Boolean())
});

export const structureHandler = createRouter()
	.http('db-client:structure:create-database', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.createDatabase) throw new Error('Driver does not support database creation');
		const ddl = await adapter.createDatabase(data.name);
		return { ok: true, ddl };
	})

	.http('db-client:structure:drop-database', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.dropDatabase) throw new Error('Driver does not support dropping databases');
		const ddl = await adapter.dropDatabase(data.name);
		return { ok: true, ddl };
	})

	.http('db-client:structure:rename-database', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			name: t.String({ minLength: 1 }),
			newName: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.renameDatabase) throw new Error('Driver does not support renaming databases');
		const ddl = await adapter.renameDatabase(data.name, data.newName);
		return { ok: true, ddl };
	})

	.http('db-client:structure:reset-database', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.resetDatabase) throw new Error('Driver does not support emptying databases');
		const ddl = await adapter.resetDatabase({ database: data.database, schema: data.schema });
		return { ok: true, ddl };
	})

	.http('db-client:structure:flush-database', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.flushDatabase) throw new Error('Driver does not support flushing the database');
		const ddl = await adapter.flushDatabase();
		return { ok: true, ddl };
	})

	.http('db-client:structure:create-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			definition: tableDefinitionSchema
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.createTable) throw new Error('Driver does not support createTable');
		const ddl = await adapter.createTable(data.definition as TableDefinition, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:alter-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			operations: t.Array(alterOpSchema)
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.alterTable) throw new Error('Driver does not support alterTable');
		const ddl = await adapter.alterTable(data.name, data.operations as AlterOperation[], {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:drop-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.dropTable) throw new Error('Driver does not support dropTable');
		const ddl = await adapter.dropTable(data.name, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:truncate-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.truncateTable) throw new Error('Driver does not support truncateTable');
		const ddl = await adapter.truncateTable(data.name, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:reset-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.resetTable) throw new Error('Driver does not support resetTable');
		const ddl = await adapter.resetTable(data.name, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:duplicate-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			newName: t.String({ minLength: 1 }),
			withData: t.Optional(t.Boolean())
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.duplicateTable) throw new Error('Driver does not support duplicateTable');
		const ddl = await adapter.duplicateTable(data.name, data.newName, {
			database: data.database,
			schema: data.schema,
			withData: data.withData
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:create-statement', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			type: t.Optional(t.String())
		}),
		response: t.Object({ ok: t.Boolean(), statement: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.getCreateStatement) throw new Error('Driver does not support fetching the CREATE statement');
		const statement = await adapter.getCreateStatement(
			data.name,
			(data.type as DbClientSchemaNodeType | undefined) ?? 'table',
			{ database: data.database, schema: data.schema }
		);
		return { ok: true, statement };
	})

	.http('db-client:structure:rename-table', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			newName: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.renameTable) throw new Error('Driver does not support renameTable');
		const ddl = await adapter.renameTable(data.name, data.newName, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:create-index', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			tableName: t.String({ minLength: 1 }),
			indexDef: indexDefinitionSchema
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.createIndex) throw new Error('Driver does not support createIndex');
		const ddl = await adapter.createIndex(data.tableName, data.indexDef as IndexDefinition, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:drop-index', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			tableName: t.String({ minLength: 1 }),
			indexName: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.dropIndex) throw new Error('Driver does not support dropIndex');
		const ddl = await adapter.dropIndex(data.tableName, data.indexName, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:create-view', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.createView) throw new Error('Driver does not support createView');
		const ddl = await adapter.createView(data.name, data.query, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	})

	.http('db-client:structure:drop-view', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			name: t.String({ minLength: 1 })
		}),
		response: t.Object({ ok: t.Boolean(), ddl: t.String() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.dropView) throw new Error('Driver does not support dropView');
		const ddl = await adapter.dropView(data.name, {
			database: data.database,
			schema: data.schema
		});
		return { ok: true, ddl };
	});

