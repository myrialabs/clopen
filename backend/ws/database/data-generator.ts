/**
 * Database Manager - Data Generator Handlers
 * RBAC-gated. Generates fake data and inserts it into the target table,
 * resolving FK constraints automatically.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { dbRbacQueries } from '../../database/queries';
import { assertCan, resolveIdentity } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { inspectTableForDatagen, generateAndInsert } from '../../db-manager/data-generator';
import { debug } from '$shared/utils/logger';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const DataGenColumnOptionsSchema = t.Object({
	min: t.Optional(t.Number()),
	max: t.Optional(t.Number()),
	decimals: t.Optional(t.Number())
});

const DataGenColumnConfigSchema = t.Object({
	columnName: t.String(),
	strategy: t.String(),
	options: t.Optional(DataGenColumnOptionsSchema),
	fkTable: t.Optional(t.String()),
	fkColumn: t.Optional(t.String()),
	skip: t.Boolean()
});

const DataGenColumnInfoSchema = t.Object({
	columnName: t.String(),
	columnType: t.String(),
	nullable: t.Boolean(),
	primaryKey: t.Boolean(),
	unique: t.Boolean(),
	defaultValue: t.Optional(t.Union([t.String(), t.Null()])),
	autoIncrement: t.Boolean(),
	suggestedStrategy: t.String(),
	fkTable: t.Optional(t.String()),
	fkColumn: t.Optional(t.String())
});

// ─── Audit helper ─────────────────────────────────────────────────────────────

function audit(params: {
	connectionId: string;
	connectionName: string;
	userId: string;
	userName: string;
	tableName: string;
	rowCount: number;
	success: boolean;
	error?: string | null;
}): void {
	try {
		dbRbacQueries.addAuditEntry({
			id: nanoid(),
			...params,
			action: 'data:generate',
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

export const datagenHandler = createRouter()
	/**
	 * Inspect a table's columns and return suggested faker strategies,
	 * FK constraint info, and auto-increment detection.
	 */
	.http(
		'db:datagen:schema',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String())
			}),
			response: t.Array(DataGenColumnInfoSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			const config = await getDecryptedConnection(data.connectionId);
			return inspectTableForDatagen(config, data.tableName, data.schema);
		}
	)

	/**
	 * Generate a batch of fake rows and insert them into the target table.
	 * The frontend drives the loop, incrementing `batchOffset` until the
	 * desired `totalRows` count is reached.
	 */
	.http(
		'db:datagen:batch',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				columnConfigs: t.Array(DataGenColumnConfigSchema),
				batchSize: t.Number({ minimum: 1, maximum: 1000 }),
				batchOffset: t.Number({ minimum: 0 }),
				totalRows: t.Number({ minimum: 1, maximum: 10000 })
			}),
			response: t.Object({
				inserted: t.Number(),
				failed: t.Number(),
				errors: t.Array(t.String()),
				done: t.Boolean()
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'data:insert');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const userName = await resolveUserName(userId);

			const remaining = data.totalRows - data.batchOffset;
			const count = Math.min(data.batchSize, remaining);
			const done = data.batchOffset + count >= data.totalRows;

			try {
				const result = await generateAndInsert(
					config,
					data.tableName,
					data.schema,
					data.columnConfigs as Parameters<typeof generateAndInsert>[3],
					count,
					data.batchOffset
				);

				if (done) {
					audit({
						connectionId: data.connectionId,
						connectionName: config.name,
						userId,
						userName,
						tableName: data.tableName,
						rowCount: data.batchOffset + result.inserted,
						success: result.failed === 0,
						error: result.errors[0] ?? null
					});
				}

				return { ...result, done };
			} catch (err) {
				debug.error('database', 'Data generation error:', err);
				const msg = err instanceof Error ? err.message : 'Generation failed';

				audit({
					connectionId: data.connectionId,
					connectionName: config.name,
					userId,
					userName,
					tableName: data.tableName,
					rowCount: 0,
					success: false,
					error: msg
				});

				return { inserted: 0, failed: count, errors: [msg], done };
			}
		}
	);
