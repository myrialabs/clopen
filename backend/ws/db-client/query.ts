/**
 * db-client — query execution WS handlers.
 */

import { t } from 'elysia';
import type { DbClientQueryResult } from '$shared/types/db-client';
import { createRouter } from '$shared/utils/ws-server';
import { connectionManager } from '../../db-client/connection-manager';
import { executeBatch, runSafely } from '../../db-client/query-executor';
import { splitSqlStatements } from '$shared/utils/db-client/split-sql';
import { dbClientQueryHistoryQueries } from '../../database/queries';
import { getDbClientPrincipal, requireDbClientConnectionAccess } from './access';
import { debug } from '$shared/utils/logger';

const HISTORY_KEEP_PER_CONNECTION = 200;
const PRUNE_EVERY_N_QUERIES = 10;

// Track insert count per connection for deterministic pruning
const insertCounters = new Map<string, number>();

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

		// Deterministic pruning: prune after every N inserts
		const count = (insertCounters.get(input.connectionId) ?? 0) + 1;
		insertCounters.set(input.connectionId, count);

		if (count >= PRUNE_EVERY_N_QUERIES) {
			dbClientQueryHistoryQueries.prune(input.connectionId, HISTORY_KEEP_PER_CONNECTION);
			insertCounters.set(input.connectionId, 0);
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
			const top = {
				...result,
				batch: result.batch ?? {
					statements: [{
						index: 0,
						query: data.query,
						queryClass: 'read' as const,
						status: 'success' as const,
						result,
						error: null,
						durationMs: result.durationMs
					}],
					totalDurationMs: result.durationMs,
					transaction: false,
					ok: true
				}
			};
			return top;
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
			const top = {
				...result,
				batch: result.batch ?? {
					statements: [{
						index: 0,
						query: data.query,
						queryClass: 'write' as const,
						status: 'success' as const,
						result,
						error: null,
						durationMs: result.durationMs
					}],
					totalDurationMs: result.durationMs,
					transaction: false,
					ok: true
				}
			};
			return top;
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

	.http('db-client:execute-batch', {
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
		// Statement splitting is a SQL concern; Mongo/Redis payloads run whole.
		const isSql = connection.driver === 'mysql' || connection.driver === 'postgres' || connection.driver === 'sqlite' || connection.driver === 'mssql';
		// SQL Server separates batch-sensitive DDL by blank lines rather than `;`.
		const split = isSql
			? splitSqlStatements(data.query, { splitOnBlankLine: connection.driver === 'mssql' })
			: [data.query.trim()];
		const statements = split.length > 0 ? split : [data.query.trim()];
		try {
			const batch = await executeBatch({
				driver: connection.driver,
				adapter,
				statements,
				params: data.params,
				database: data.database,
				limit: data.limit
			});
			const rowCount = batch.statements.reduce((acc, s) => acc + (s.result?.rowCount ?? 0), 0);
			const affectedRows = batch.statements.reduce((acc, s) => acc + (s.result?.affectedRows ?? 0), 0);
			const failed = batch.statements.find((s) => s.status === 'error');
			recordHistory({
				connectionId: data.connectionId,
				userId,
				query: data.query,
				status: batch.ok ? 'success' : 'error',
				durationMs: batch.totalDurationMs,
				rowCount,
				error: failed?.error ?? null
			});
			// Mirror the last statement that produced rows at the top level (so
			// existing single-result consumers keep working) with the full
			// per-statement report attached under `batch`.
			const reversed = [...batch.statements].reverse();
			const lastResult = reversed.find((s) => s.result && s.result.rows.length > 0)?.result
				?? reversed.find((s) => s.result)?.result
				?? null;
			const top: DbClientQueryResult = lastResult
				? { ...lastResult, durationMs: batch.totalDurationMs, batch }
				: { columns: [], rows: [], rowCount, affectedRows, durationMs: batch.totalDurationMs, driverMeta: {}, batch };
			return top;
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
