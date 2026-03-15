/**
 * Database Manager - Streaming Export & Import Handlers
 * Handles server-side batch fetching for large-dataset export,
 * SQL dump generation, and batch import with column mapping.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { dbRbacQueries } from '../../database/queries';
import { assertCan, resolveIdentity } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { fetchExportBatch, generateCreateTableSql, importBatch } from '../../db-manager/export';
import { ws } from '$backend/utils/ws';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const ColumnMappingSchema = t.Object({
	sourceColumn: t.String(),
	targetColumn: t.Union([t.String(), t.Null()])
});

// ─── Audit helper ─────────────────────────────────────────────────────────────

function audit(params: {
	connectionId: string;
	connectionName: string;
	userId: string;
	userName: string;
	action: string;
	tableName?: string | null;
	rowCount?: number | null;
	success: boolean;
	error?: string | null;
}): void {
	try {
		dbRbacQueries.addAuditEntry({
			id: nanoid(),
			...params,
			sql: null,
			executionTimeMs: null,
			ipAddress: null,
			performedAt: new Date().toISOString()
		});
	} catch {
		// Never fail the main operation
	}
}

async function resolveUserName(userId: string): Promise<string> {
	try {
		const { authQueries } = await import('../../database/queries');
		return authQueries.getUserById(userId)?.name ?? userId;
	} catch {
		return userId;
	}
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const exportHandler = createRouter()
	/**
	 * Fetch a batch of rows for streaming export.
	 * The frontend loops through batches until `done` is true.
	 */
	.http(
		'db:export:batch',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				offset: t.Number({ minimum: 0 }),
				batchSize: t.Number({ minimum: 1, maximum: 10000 })
			}),
			response: t.Object({
				rows: t.Array(t.Record(t.String(), t.Any())),
				total: t.Number(),
				offset: t.Number(),
				done: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);

			const { rows, total } = await fetchExportBatch(
				config,
				data.tableName,
				data.schema,
				data.offset,
				data.batchSize
			);

			const done = data.offset + rows.length >= total;
			return { rows, total, offset: data.offset, done };
		}
	)

	/**
	 * Get the CREATE TABLE SQL for a table (used in SQL dump export).
	 */
	.http(
		'db:export:schema',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String())
			}),
			response: t.Object({ sql: t.String() })
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			const sql = await generateCreateTableSql(config, data.tableName, data.schema);
			return { sql };
		}
	)

	/**
	 * Import a batch of rows with column mappings.
	 * The frontend sends batches until the file is fully imported.
	 */
	.http(
		'db:import:batch',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				rows: t.Array(t.Record(t.String(), t.Any())),
				mappings: t.Array(ColumnMappingSchema),
				skipErrors: t.Boolean()
			}),
			response: t.Object({
				inserted: t.Number(),
				failed: t.Number(),
				errors: t.Array(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:insert');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);

			const result = await importBatch(
				config,
				data.tableName,
				data.schema,
				data.rows,
				data.mappings,
				data.skipErrors
			);

			audit({
				connectionId: data.connectionId,
				connectionName: config.name,
				userId,
				userName,
				action: 'data:import:batch',
				tableName: data.tableName,
				rowCount: result.inserted,
				success: result.failed === 0,
				error: result.errors.length ? result.errors[0] : null
			});

			return result;
		}
	);
