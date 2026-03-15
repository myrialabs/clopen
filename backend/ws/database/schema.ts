/**
 * Database Manager - Schema / Alter Table Handlers
 * RBAC-gated. Schema apply operations produce an audit log entry.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { dbRbacQueries, schemaVersionQueries } from '../../database/queries';
import type { AlterChange, DBColumnDef } from '$shared/types/alter-table';
import { generateAlterStatements } from '../../db-manager/alter-table-generator';
import { describeTableWithFks, applyAlterStatements } from '../../db-manager';
import { applyChangesToColumns, generateDownStatements } from '../../db-manager/schema-versioning';
import { assertCan, resolveIdentity } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

// ─── Elysia type schemas ───────────────────────────────────────────────────────

const ForeignKeyDefSchema = t.Object({
	fromColumn: t.Optional(t.String()),
	table: t.String(),
	column: t.String(),
	onDelete: t.Optional(
		t.Union([t.Literal('CASCADE'), t.Literal('SET NULL'), t.Literal('RESTRICT'), t.Literal('NO ACTION')])
	),
	onUpdate: t.Optional(
		t.Union([t.Literal('CASCADE'), t.Literal('SET NULL'), t.Literal('RESTRICT'), t.Literal('NO ACTION')])
	),
	constraintName: t.Optional(t.String())
});

const DBColumnDefSchema = t.Object({
	name: t.String(),
	type: t.String(),
	nullable: t.Boolean(),
	primaryKey: t.Boolean(),
	unique: t.Boolean(),
	defaultValue: t.Optional(t.Union([t.String(), t.Null()])),
	foreignKey: t.Optional(t.Union([ForeignKeyDefSchema, t.Null()]))
});

const AlterChangeSchema = t.Object({
	id: t.String(),
	type: t.Union([t.Literal('add'), t.Literal('drop'), t.Literal('rename'), t.Literal('modify')]),
	columnName: t.String(),
	newName: t.Optional(t.String()),
	newDef: t.Optional(DBColumnDefSchema)
});

const AlterWarningSchema = t.Object({
	severity: t.Union([t.Literal('error'), t.Literal('warning')]),
	changeId: t.String(),
	message: t.String()
});

const AlterPreviewSchema = t.Object({
	statements: t.Array(t.String()),
	warnings: t.Array(AlterWarningSchema),
	requiresRecreate: t.Boolean(),
	transactional: t.Boolean(),
	hasErrors: t.Boolean()
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const schemaHandler = createRouter()
	// Load column definitions with FK info for a table
	.http(
		'db:schema:columns',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String())
			}),
			response: t.Array(DBColumnDefSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			const config = await getDecryptedConnection(data.connectionId);
			return describeTableWithFks(config, data.tableName, data.schema);
		}
	)

	// Generate SQL preview from changes (no DB mutation)
	.http(
		'db:schema:preview',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				changes: t.Array(AlterChangeSchema)
			}),
			response: AlterPreviewSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'schema:alter');
			const config = await getDecryptedConnection(data.connectionId);
			const existingColumns = await describeTableWithFks(config, data.tableName, data.schema);
			return generateAlterStatements(
				config.type,
				data.tableName,
				data.schema,
				data.changes as AlterChange[],
				existingColumns as DBColumnDef[]
			);
		}
	)

	// Apply ALTER TABLE changes to the database
	.http(
		'db:schema:apply',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				schema: t.Optional(t.String()),
				changes: t.Array(AlterChangeSchema)
			}),
			response: t.Object({
				ok: t.Boolean(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'schema:alter');
			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const state = ws.getConnectionState(conn);
			const ip = ws.getRemoteAddress(conn);

			let userName = userId;
			try {
				const { authQueries } = await import('../../database/queries');
				userName = authQueries.getUserById(userId)?.name ?? userId;
			} catch {
				// ignore
			}

			try {
				const existingColumns = await describeTableWithFks(config, data.tableName, data.schema);
				const preview = generateAlterStatements(
					config.type,
					data.tableName,
					data.schema,
					data.changes as AlterChange[],
					existingColumns as DBColumnDef[]
				);
				if (preview.hasErrors) {
					return { ok: false, error: 'Cannot apply: blocking errors exist in the change set' };
				}
				const result = await applyAlterStatements(config, preview.statements);

				dbRbacQueries.addAuditEntry({
					id: nanoid(),
					connectionId: data.connectionId,
					connectionName: config.name,
					userId,
					userName,
					action: 'schema:alter',
					sql: preview.statements.join(';\n'),
					tableName: data.tableName,
					rowCount: null,
					executionTimeMs: null,
					success: result.ok,
					error: result.error ?? null,
					ipAddress: ip,
					performedAt: new Date().toISOString()
				});

				void state; // suppress unused warning

				if (result.ok) {
					try {
						const columnsAfter = applyChangesToColumns(
							existingColumns as DBColumnDef[],
							data.changes as AlterChange[]
						);
						const downPreview = generateDownStatements(
							config.type,
							data.tableName,
							data.schema,
							data.changes as AlterChange[],
							existingColumns as DBColumnDef[]
						);
						const versionNumber = schemaVersionQueries.getNextVersionNumber(
							data.connectionId,
							data.tableName
						);
						schemaVersionQueries.add({
							id: nanoid(),
							connectionId: data.connectionId,
							connectionName: config.name,
							connectionType: config.type,
							tableName: data.tableName,
							schemaName: data.schema,
							versionNumber,
							upStatements: preview.statements,
							downStatements: downPreview.statements,
							changes: data.changes as AlterChange[],
							columnsBefore: existingColumns as DBColumnDef[],
							columnsAfter,
							appliedById: userId,
							appliedByName: userName,
							appliedAt: new Date().toISOString()
						});
					} catch (versionErr) {
						// Version recording is best-effort — do not fail the apply
						debug.error('database', 'Failed to record schema version:', versionErr);
					}
				}

				return result;
			} catch (err) {
				debug.error('database', 'Schema apply error:', err);
				const errMsg = err instanceof Error ? err.message : 'Failed to apply changes';

				dbRbacQueries.addAuditEntry({
					id: nanoid(),
					connectionId: data.connectionId,
					connectionName: config.name,
					userId,
					userName,
					action: 'schema:alter',
					sql: null,
					tableName: data.tableName,
					rowCount: null,
					executionTimeMs: null,
					success: false,
					error: errMsg,
					ipAddress: ip,
					performedAt: new Date().toISOString()
				});

				return { ok: false, error: errMsg };
			}
		}
	);
