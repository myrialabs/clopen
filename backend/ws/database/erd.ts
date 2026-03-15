/**
 * Database Manager - ERD Metadata Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { settingsQueries } from '../../database/queries';
import type { DBConnectionConfig } from '$shared/types/db-manager';
import { getERDMetadata } from '../../db-manager';

const STORAGE_KEY = 'db-manager:connections';

function getConnectionById(id: string): DBConnectionConfig {
	try {
		const setting = settingsQueries.get(STORAGE_KEY);
		if (!setting) throw new Error('No connections found');
		const connections = JSON.parse(setting.value as string) as DBConnectionConfig[];
		const conn = connections.find((c) => c.id === id);
		if (!conn) throw new Error('Connection not found');
		return conn;
	} catch (err) {
		throw err instanceof Error ? err : new Error('Failed to load connection');
	}
}

const ERDColumnSchema = t.Object({
	name: t.String(),
	type: t.String(),
	isPrimary: t.Boolean(),
	isForeign: t.Boolean()
});

const ERDTableMetaSchema = t.Object({
	name: t.String(),
	schema: t.Optional(t.String()),
	columns: t.Array(ERDColumnSchema)
});

const ERDRelationshipSchema = t.Object({
	fromTable: t.String(),
	fromColumn: t.String(),
	toTable: t.String(),
	toColumn: t.String(),
	constraintName: t.Optional(t.String())
});

export const erdHandler = createRouter().http(
	'db:erd:metadata',
	{
		data: t.Object({ connectionId: t.String() }),
		response: t.Object({
			tables: t.Array(ERDTableMetaSchema),
			relationships: t.Array(ERDRelationshipSchema)
		})
	},
	async ({ data }) => {
		const config = getConnectionById(data.connectionId);
		return getERDMetadata(config);
	}
);
