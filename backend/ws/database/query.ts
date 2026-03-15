/**
 * Database Manager - Query & Explore Handlers
 * RBAC-gated. All write operations produce an audit log entry.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { queryHistoryQueries, dbRbacQueries } from '../../database/queries';
import {
	listTables,
	describeTable,
	executeQuery,
	getTableData,
	getTableRowCount,
	insertRow,
	updateRow,
	deleteRows,
	fetchRowSnapshot,
	globalSearch,
	globalSearchSuggest,
	bulkDeleteRows,
	bulkUpdateRows
} from '../../db-manager';
import { assertCan, resolveIdentity, classifySql } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { ws } from '$backend/utils/ws';

// ─── Audit helper ─────────────────────────────────────────────────────────────

interface AuditParams {
	connectionId: string;
	connectionName: string;
	userId: string;
	userName: string;
	action: string;
	sql?: string | null;
	tableName?: string | null;
	rowCount?: number | null;
	executionTimeMs?: number | null;
	success: boolean;
	error?: string | null;
	ipAddress?: string | null;
	beforeData?: string | null;
	afterData?: string | null;
	pkColumn?: string | null;
	pkValue?: string | null;
}

function audit(params: AuditParams): void {
	try {
		dbRbacQueries.addAuditEntry({
			id: nanoid(),
			connectionId: params.connectionId,
			connectionName: params.connectionName,
			userId: params.userId,
			userName: params.userName,
			action: params.action,
			sql: params.sql ?? null,
			tableName: params.tableName ?? null,
			rowCount: params.rowCount ?? null,
			executionTimeMs: params.executionTimeMs ?? null,
			success: params.success,
			error: params.error ?? null,
			ipAddress: params.ipAddress ?? null,
			performedAt: new Date().toISOString(),
			beforeData: params.beforeData ?? null,
			afterData: params.afterData ?? null,
			pkColumn: params.pkColumn ?? null,
			pkValue: params.pkValue ?? null
		});
	} catch {
		// Never fail the main operation because of audit logging
	}
}

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const DBFilterSchema = t.Object({
	column: t.String(),
	operator: t.Union([
		t.Literal('eq'), t.Literal('neq'), t.Literal('like'),
		t.Literal('gt'), t.Literal('lt'), t.Literal('null'), t.Literal('notnull')
	]),
	value: t.Optional(t.String())
});

const DBColumnSchema = t.Object({
	name: t.String(),
	type: t.String(),
	nullable: t.Boolean(),
	primaryKey: t.Boolean(),
	unique: t.Optional(t.Boolean()),
	defaultValue: t.Optional(t.Union([t.String(), t.Null()]))
});

const DBTableSchema = t.Object({
	name: t.String(),
	schema: t.Optional(t.String()),
	type: t.Union([t.Literal('table'), t.Literal('view')]),
	rowCount: t.Optional(t.Number())
});

const DBQueryResultSchema = t.Object({
	columns: t.Array(t.String()),
	rows: t.Array(t.Record(t.String(), t.Any())),
	rowCount: t.Number(),
	executionTimeMs: t.Number(),
	affectedRows: t.Optional(t.Number()),
	totalCount: t.Optional(t.Number()),
	error: t.Optional(t.String())
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const queryHandler = createRouter()
	// List tables for a connection
	.http(
		'db:explore:tables',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Array(DBTableSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			const config = await getDecryptedConnection(data.connectionId);
			return listTables(config);
		}
	)

	// Describe table columns
	.http(
		'db:explore:columns',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String())
			}),
			response: t.Array(DBColumnSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			const config = await getDecryptedConnection(data.connectionId);
			return describeTable(config, data.tableName, data.schema);
		}
	)

	// Browse table data (with optional filters) — SELECT permission required
	.http(
		'db:explore:data',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				limit: t.Optional(t.Number()),
				offset: t.Optional(t.Number()),
				filters: t.Optional(t.Array(DBFilterSchema))
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return getTableData(
				config,
				data.tableName,
				data.schema,
				data.limit ?? 100,
				data.offset ?? 0,
				data.filters
			);
		}
	)

	// Get total row count (for pagination)
	.http(
		'db:data:count',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				filters: t.Optional(t.Array(DBFilterSchema))
			}),
			response: t.Number()
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return getTableRowCount(config, data.tableName, data.schema, data.filters);
		}
	)

	// Execute arbitrary SQL/command query
	.http(
		'db:query:execute',
		{
			data: t.Object({
				connectionId: t.String(),
				sql: t.String({ minLength: 1 }),
				activeTable: t.Optional(t.String())
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			// Classify the SQL to determine required permission
			const requiredAction = classifySql(data.sql);
			assertCan(conn, data.connectionId, requiredAction);

			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const state = ws.getConnectionState(conn);
			const userName = state ? await resolveUserName(state.userId!) : 'unknown';
			const ip = ws.getRemoteAddress(conn);

			const result = await executeQuery(config, data.sql, data.activeTable);

			// Auto-save to query history (best-effort)
			try {
				queryHistoryQueries.add({
					id: nanoid(),
					connectionId: data.connectionId,
					connectionName: config.name,
					connectionType: config.type,
					sql: data.sql,
					executionTimeMs: result.executionTimeMs,
					rowCount: result.rowCount,
					error: result.error ?? null,
					executedAt: new Date().toISOString()
				});
			} catch {
				// Ignore
			}

			// Audit log
			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: `query:execute (${requiredAction})`,
				sql: data.sql,
				tableName: data.activeTable ?? null,
				rowCount: result.rowCount,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip
			});

			return result;
		}
	)

	// Explain/analyze a query
	.http(
		'db:query:explain',
		{
			data: t.Object({
				connectionId: t.String(),
				sql: t.String({ minLength: 1 })
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			let explainSql: string;
			switch (config.type) {
				case 'sqlite':
					explainSql = `EXPLAIN QUERY PLAN ${data.sql}`;
					break;
				case 'postgresql':
					explainSql = `EXPLAIN (ANALYZE true, BUFFERS true, FORMAT TEXT) ${data.sql}`;
					break;
				case 'mysql':
				case 'mariadb':
					explainSql = `EXPLAIN ${data.sql}`;
					break;
				default:
					throw new Error(`EXPLAIN not supported for database type: ${config.type}`);
			}
			return executeQuery(config, explainSql);
		}
	)

	// Insert a row
	.http(
		'db:data:insert',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				rowData: t.Record(t.String(), t.Any()),
				pkColumn: t.Optional(t.String())
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:insert');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);
			const ip = ws.getRemoteAddress(conn);

			const result = await insertRow(config, data.tableName, data.schema, data.rowData);

			// Capture PK value if the PK column was explicitly provided in rowData
			const pkCol = data.pkColumn ?? null;
			const pkVal =
				pkCol && Object.prototype.hasOwnProperty.call(data.rowData, pkCol)
					? data.rowData[pkCol]
					: null;

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: 'data:insert',
				tableName: data.tableName,
				rowCount: 1,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip,
				afterData: JSON.stringify(data.rowData),
				pkColumn: pkCol,
				pkValue: pkVal !== null ? JSON.stringify(pkVal) : null
			});

			return result;
		}
	)

	// Update a row by PK
	.http(
		'db:data:update',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				pkColumn: t.String(),
				pkValue: t.Any(),
				rowData: t.Record(t.String(), t.Any())
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:update');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);
			const ip = ws.getRemoteAddress(conn);

			// Snapshot the row BEFORE updating for diff & rollback
			let beforeSnapshot: Record<string, unknown> | null = null;
			try {
				const rows = await fetchRowSnapshot(
					config, data.tableName, data.schema, data.pkColumn, [data.pkValue]
				);
				beforeSnapshot = rows[0] ?? null;
			} catch {
				// Never block the main operation because of snapshot fetch
			}

			const result = await updateRow(
				config, data.tableName, data.schema,
				data.pkColumn, data.pkValue, data.rowData
			);

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: 'data:update',
				tableName: data.tableName,
				rowCount: 1,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip,
				beforeData: beforeSnapshot ? JSON.stringify(beforeSnapshot) : null,
				afterData: JSON.stringify(data.rowData),
				pkColumn: data.pkColumn,
				pkValue: JSON.stringify(data.pkValue)
			});

			return result;
		}
	)

	// Delete rows by PK values
	.http(
		'db:data:delete',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				pkColumn: t.String(),
				pkValues: t.Array(t.Any())
			}),
			response: DBQueryResultSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:delete');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);
			const ip = ws.getRemoteAddress(conn);

			// Snapshot deleted rows BEFORE removing them for rollback
			let beforeRows: Record<string, unknown>[] = [];
			try {
				beforeRows = await fetchRowSnapshot(
					config, data.tableName, data.schema, data.pkColumn, data.pkValues
				);
			} catch {
				// Never block the main operation because of snapshot fetch
			}

			const result = await deleteRows(
				config, data.tableName, data.schema,
				data.pkColumn, data.pkValues
			);

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: 'data:delete',
				tableName: data.tableName,
				rowCount: data.pkValues.length,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip,
				beforeData: beforeRows.length ? JSON.stringify(beforeRows) : null,
				pkColumn: data.pkColumn,
				pkValue: JSON.stringify(data.pkValues)
			});

			return result;
		}
	)

	// ─── Bulk delete (filter-mode or PK-mode, wrapped in transaction) ──────────
	.http(
		'db:bulk:delete',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				mode: t.Union([t.Literal('filter'), t.Literal('pks')]),
				filters: t.Optional(t.Array(DBFilterSchema)),
				pkColumn: t.Optional(t.String()),
				pkValues: t.Optional(t.Array(t.Any()))
			}),
			response: t.Object({
				affectedRows: t.Number(),
				executionTimeMs: t.Number(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:delete');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);
			const ip = ws.getRemoteAddress(conn);

			const options =
				data.mode === 'filter'
					? { mode: 'filter' as const, filters: data.filters ?? [] }
					: { mode: 'pks' as const, pkColumn: data.pkColumn!, pkValues: data.pkValues ?? [] };

			const result = await bulkDeleteRows(config, data.tableName, data.schema, options);

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: `data:bulk:delete (${data.mode})`,
				tableName: data.tableName,
				rowCount: result.affectedRows,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip
			});

			return result;
		}
	)

	// ─── Bulk update column value (filter-mode or PK-mode, wrapped in transaction)
	.http(
		'db:bulk:update',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				column: t.String(),
				value: t.Union([t.String(), t.Number(), t.Boolean(), t.Null()]),
				mode: t.Union([t.Literal('filter'), t.Literal('pks')]),
				filters: t.Optional(t.Array(DBFilterSchema)),
				pkColumn: t.Optional(t.String()),
				pkValues: t.Optional(t.Array(t.Any()))
			}),
			response: t.Object({
				affectedRows: t.Number(),
				executionTimeMs: t.Number(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:update');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);
			const ip = ws.getRemoteAddress(conn);

			const options =
				data.mode === 'filter'
					? { mode: 'filter' as const, filters: data.filters ?? [] }
					: { mode: 'pks' as const, pkColumn: data.pkColumn!, pkValues: data.pkValues ?? [] };

			const result = await bulkUpdateRows(config, data.tableName, data.schema, data.column, data.value, options);

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: `data:bulk:update (${data.mode})`,
				tableName: data.tableName,
				rowCount: result.affectedRows,
				executionTimeMs: result.executionTimeMs,
				success: !result.error,
				error: result.error ?? null,
				ipAddress: ip
			});

			return result;
		}
	)

	// Autocomplete suggestions — fast DISTINCT prefix-match on text columns
	.http(
		'db:search:suggest',
		{
			data: t.Object({
				connectionId: t.String(),
				query: t.String({ minLength: 1 }),
				maxSuggestions: t.Optional(t.Number())
			}),
			response: t.Array(t.Object({
				value: t.String(),
				tableName: t.String(),
				tableSchema: t.Optional(t.String()),
				columnName: t.String()
			}))
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return globalSearchSuggest(config, data.query, {
				maxSuggestions: data.maxSuggestions
			});
		}
	)

	// Global database search — scan all tables/columns for a string value
	.http(
		'db:search:global',
		{
			data: t.Object({
				connectionId: t.String(),
				query: t.String({ minLength: 1 }),
				maxMatchesPerTable: t.Optional(t.Number()),
				maxTotalMatches: t.Optional(t.Number())
			}),
			response: t.Object({
				query: t.String(),
				matches: t.Array(t.Object({
					tableName: t.String(),
					tableSchema: t.Optional(t.String()),
					columnName: t.String(),
					row: t.Record(t.String(), t.Any()),
					pkColumn: t.Optional(t.String())
				})),
				tablesSearched: t.Number(),
				columnsSearched: t.Number(),
				executionTimeMs: t.Number(),
				truncated: t.Boolean(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return globalSearch(config, data.query, {
				maxMatchesPerTable: data.maxMatchesPerTable,
				maxTotalMatches: data.maxTotalMatches
			});
		}
	);

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveUserName(userId: string): Promise<string> {
	try {
		const { authQueries } = await import('../../database/queries');
		return authQueries.getUserById(userId)?.name ?? userId;
	} catch {
		return userId;
	}
}
