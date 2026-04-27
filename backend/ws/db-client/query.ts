/**
 * db-client — query execution WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import { runSafely } from '../../db-client/query-executor';
import { dbClientConnectionQueries, dbClientQueryHistoryQueries } from '../../database/queries';
import type { DbClientQueryResult } from '$shared/types/db-client';

const HISTORY_KEEP_PER_CONNECTION = 200;

function recordHistory(input: {
	connectionId: string;
	query: string;
	status: 'success' | 'error';
	durationMs: number | null;
	rowCount: number | null;
	error: string | null;
}): void {
	try {
		dbClientQueryHistoryQueries.insert({
			connectionId: input.connectionId,
			userId: null,
			query: input.query,
			durationMs: input.durationMs,
			rowCount: input.rowCount,
			status: input.status,
			error: input.error
		});
		if (Math.random() < 0.05) {
			dbClientQueryHistoryQueries.prune(input.connectionId, HISTORY_KEEP_PER_CONNECTION);
		}
	} catch {
		// history must never break query execution
	}
}

export const queryHandler = createRouter()
	.http('db-client:execute-read', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 }),
			params: t.Optional(t.Array(t.Any())),
			database: t.Optional(t.String()),
			limit: t.Optional(t.Number())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const conn = dbClientConnectionQueries.get(data.connectionId);
		if (!conn) throw new Error('db-client connection not found');
		const adapter = await connectionManager.get(data.connectionId);
		return runSafely({
			driver: conn.driver,
			adapter,
			query: data.query,
			params: data.params,
			mode: 'read',
			database: data.database,
			limit: data.limit
		});
	})

	.http('db-client:execute-write', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 }),
			params: t.Optional(t.Array(t.Any())),
			database: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const conn = dbClientConnectionQueries.get(data.connectionId);
		if (!conn) throw new Error('db-client connection not found');
		const adapter = await connectionManager.get(data.connectionId);
		return runSafely({
			driver: conn.driver,
			adapter,
			query: data.query,
			params: data.params,
			mode: 'write',
			database: data.database
		});
	})

	.http('db-client:explain', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 }),
			database: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.explain) throw new Error('Driver does not support EXPLAIN');
		return adapter.explain(data.query, { database: data.database });
	})

	.http('db-client:cancel', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		const adapter = await connectionManager.get(data.connectionId);
		if (adapter.cancel) await adapter.cancel();
		return { ok: true };
	})

	.http('db-client:data:insert', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			table: t.String({ minLength: 1 }),
			row: t.Record(t.String(), t.Any())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.insertRow) throw new Error('Driver does not support insertRow');
		return adapter.insertRow(data.table, data.row, {
			database: data.database,
			schema: data.schema
		});
	})

	.http('db-client:data:update', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			table: t.String({ minLength: 1 }),
			pk: t.Record(t.String(), t.Any()),
			changes: t.Record(t.String(), t.Any())
		}),
		response: t.Any()
	}, async ({ data }) => {
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.updateRow) throw new Error('Driver does not support updateRow');
		return adapter.updateRow(data.table, data.pk, data.changes, {
			database: data.database,
			schema: data.schema
		});
	})

	.http('db-client:data:delete', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			database: t.Optional(t.String()),
			schema: t.Optional(t.String()),
			table: t.String({ minLength: 1 }),
			pks: t.Array(t.Record(t.String(), t.Any()))
		}),
		response: t.Any()
	}, async ({ data }) => {
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.deleteRows) throw new Error('Driver does not support deleteRows');
		return adapter.deleteRows(data.table, data.pks, {
			database: data.database,
			schema: data.schema
		});
	});
