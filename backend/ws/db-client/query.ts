/**
 * db-client — query execution WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import { runSafely } from '../../db-client/query-executor';
import { dbClientQueryHistoryQueries } from '../../database/queries';
import { getDbClientPrincipal, requireDbClientConnectionAccess } from './access';
import { debug } from '$shared/utils/logger';

const HISTORY_KEEP_PER_CONNECTION = 200;

function recordHistory(input: {
	connectionId: string;
	userId: string | null;
	query: string;
	status: 'success' | 'error';
	durationMs: number | null;
	rowCount: number | null;
	error: string | null;
}): void {
	try {
		dbClientQueryHistoryQueries.insert({
			connectionId: input.connectionId,
			userId: input.userId,
			query: input.query,
			durationMs: input.durationMs,
			rowCount: input.rowCount,
			status: input.status,
			error: input.error
		});
		if (Math.random() < 0.05) {
			dbClientQueryHistoryQueries.prune(input.connectionId, HISTORY_KEEP_PER_CONNECTION);
		}
	} catch (err) {
		// history must never break query execution
		debug.warn('db-client', 'Failed to record query history:', err);
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
	}, async ({ data, conn }) => {
		const { userId } = getDbClientPrincipal(conn);
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		try {
			const result = await runSafely({
				driver: connection.driver,
				adapter,
				query: data.query,
				params: data.params,
				mode: 'read',
				database: data.database,
				limit: data.limit
			});
			recordHistory({
				connectionId: data.connectionId,
				userId,
				query: data.query,
				status: 'success',
				durationMs: result.durationMs ?? null,
				rowCount: result.rowCount ?? null,
				error: null
			});
			return result;
		} catch (error) {
			recordHistory({
				connectionId: data.connectionId,
				userId,
				query: data.query,
				status: 'error',
				durationMs: null,
				rowCount: null,
				error: error instanceof Error ? error.message : String(error)
			});
			throw error;
		}
	})

	.http('db-client:execute-write', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 }),
			params: t.Optional(t.Array(t.Any())),
			database: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const { userId } = getDbClientPrincipal(conn);
		const connection = requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		try {
			const result = await runSafely({
				driver: connection.driver,
				adapter,
				query: data.query,
				params: data.params,
				mode: 'write',
				database: data.database
			});
			recordHistory({
				connectionId: data.connectionId,
				userId,
				query: data.query,
				status: 'success',
				durationMs: result.durationMs ?? null,
				rowCount: result.rowCount ?? null,
				error: null
			});
			return result;
		} catch (error) {
			recordHistory({
				connectionId: data.connectionId,
				userId,
				query: data.query,
				status: 'error',
				durationMs: null,
				rowCount: null,
				error: error instanceof Error ? error.message : String(error)
			});
			throw error;
		}
	})

	.http('db-client:explain', {
		data: t.Object({
			connectionId: t.String({ minLength: 1 }),
			query: t.String({ minLength: 1 }),
			database: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.explain) throw new Error('Driver does not support EXPLAIN');
		return adapter.explain(data.query, { database: data.database });
	})

	.http('db-client:cancel', {
		data: t.Object({ connectionId: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
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
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
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
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
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
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.connectionId);
		const adapter = await connectionManager.get(data.connectionId);
		if (!adapter.deleteRows) throw new Error('Driver does not support deleteRows');
		return adapter.deleteRows(data.table, data.pks, {
			database: data.database,
			schema: data.schema
		});
	});
