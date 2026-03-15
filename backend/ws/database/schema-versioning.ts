/**
 * Database Manager - Schema Versioning Handlers
 * List, inspect, diff, rollback, and export tracked schema versions.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { schemaVersionQueries, dbRbacQueries } from '../../database/queries';
import { assertCan, resolveIdentity } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { applyAlterStatements } from '../../db-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import type { ColumnVersionDiff, SchemaVersionDiff } from '$shared/types/schema-versioning';
import type { DBColumnDef } from '$shared/types/alter-table';

// ─── Elysia schema fragments ──────────────────────────────────────────────────

const SummarySchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	connectionName: t.String(),
	connectionType: t.String(),
	tableName: t.String(),
	schemaName: t.Union([t.String(), t.Null()]),
	versionNumber: t.Number(),
	label: t.Union([t.String(), t.Null()]),
	changesCount: t.Number(),
	appliedByName: t.String(),
	appliedAt: t.String(),
	status: t.Union([t.Literal('applied'), t.Literal('rolled_back')])
});

const ColumnDefSchema = t.Object({
	name: t.String(),
	type: t.String(),
	nullable: t.Boolean(),
	primaryKey: t.Boolean(),
	unique: t.Boolean(),
	defaultValue: t.Optional(t.Union([t.String(), t.Null()])),
	foreignKey: t.Optional(t.Union([
		t.Object({
			fromColumn: t.Optional(t.String()),
			table: t.String(),
			column: t.String(),
			onDelete: t.Optional(t.String()),
			onUpdate: t.Optional(t.String()),
			constraintName: t.Optional(t.String())
		}),
		t.Null()
	]))
});

const AlterChangeSchema = t.Object({
	id: t.String(),
	type: t.Union([t.Literal('add'), t.Literal('drop'), t.Literal('rename'), t.Literal('modify')]),
	columnName: t.String(),
	newName: t.Optional(t.String()),
	newDef: t.Optional(ColumnDefSchema)
});

const FullVersionSchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	connectionName: t.String(),
	connectionType: t.String(),
	tableName: t.String(),
	schemaName: t.Union([t.String(), t.Null()]),
	versionNumber: t.Number(),
	label: t.Union([t.String(), t.Null()]),
	upStatements: t.Array(t.String()),
	downStatements: t.Array(t.String()),
	changes: t.Array(AlterChangeSchema),
	columnsBefore: t.Array(ColumnDefSchema),
	columnsAfter: t.Array(ColumnDefSchema),
	appliedById: t.String(),
	appliedByName: t.String(),
	appliedAt: t.String(),
	status: t.Union([t.Literal('applied'), t.Literal('rolled_back')]),
	notes: t.Union([t.String(), t.Null()])
});

const ColumnDiffSchema = t.Object({
	name: t.String(),
	status: t.Union([
		t.Literal('added'),
		t.Literal('removed'),
		t.Literal('modified'),
		t.Literal('unchanged')
	]),
	before: t.Union([ColumnDefSchema, t.Null()]),
	after: t.Union([ColumnDefSchema, t.Null()])
});

const DiffSchema = t.Object({
	versionIdA: t.String(),
	versionIdB: t.String(),
	labelA: t.String(),
	labelB: t.String(),
	columns: t.Array(ColumnDiffSchema),
	hasChanges: t.Boolean()
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeColumnDiff(before: DBColumnDef[], after: DBColumnDef[]): ColumnVersionDiff[] {
	const result: ColumnVersionDiff[] = [];
	const beforeMap = new Map(before.map((c) => [c.name, c]));
	const afterMap = new Map(after.map((c) => [c.name, c]));
	const allNames = new Set([...before.map((c) => c.name), ...after.map((c) => c.name)]);

	for (const name of allNames) {
		const b = beforeMap.get(name) ?? null;
		const a = afterMap.get(name) ?? null;

		if (!b && a) {
			result.push({ name, status: 'added', before: null, after: a });
		} else if (b && !a) {
			result.push({ name, status: 'removed', before: b, after: null });
		} else if (b && a) {
			const changed =
				b.type !== a.type ||
				b.nullable !== a.nullable ||
				b.primaryKey !== a.primaryKey ||
				b.unique !== a.unique ||
				(b.defaultValue ?? null) !== (a.defaultValue ?? null);
			result.push({ name, status: changed ? 'modified' : 'unchanged', before: b, after: a });
		}
	}

	return result;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const schemaVersioningHandler = createRouter()
	// List version summaries for a specific table
	.http(
		'db:schema:version:list',
		{
			data: t.Object({
				connectionId: t.String(),
				tableName: t.String(),
				limit: t.Optional(t.Number())
			}),
			response: t.Array(SummarySchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			return schemaVersionQueries.listByTable(data.connectionId, data.tableName, data.limit ?? 50);
		}
	)

	// List all version summaries across all tables for a connection
	.http(
		'db:schema:version:list-connection',
		{
			data: t.Object({
				connectionId: t.String(),
				limit: t.Optional(t.Number())
			}),
			response: t.Array(SummarySchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			return schemaVersionQueries.listByConnection(data.connectionId, data.limit ?? 100);
		}
	)

	// Get full version detail including SQL and column snapshots
	.http(
		'db:schema:version:get',
		{
			data: t.Object({ id: t.String() }),
			response: t.Union([FullVersionSchema, t.Null()])
		},
		async ({ data, conn }) => {
			const version = schemaVersionQueries.getById(data.id);
			if (!version) return null;
			assertCan(conn, version.connectionId, 'connection:view');
			return version;
		}
	)

	// Compute diff between two version snapshots (columnsAfter of A vs columnsAfter of B)
	.http(
		'db:schema:version:diff',
		{
			data: t.Object({
				versionIdA: t.String(),
				versionIdB: t.String()
			}),
			response: t.Union([DiffSchema, t.Null()])
		},
		async ({ data, conn }) => {
			const vA = schemaVersionQueries.getById(data.versionIdA);
			const vB = schemaVersionQueries.getById(data.versionIdB);
			if (!vA || !vB) return null;

			assertCan(conn, vA.connectionId, 'connection:view');

			const columns = computeColumnDiff(vA.columnsAfter, vB.columnsAfter);
			const diff: SchemaVersionDiff = {
				versionIdA: vA.id,
				versionIdB: vB.id,
				labelA: vA.label ?? `v${vA.versionNumber} — ${vA.tableName}`,
				labelB: vB.label ?? `v${vB.versionNumber} — ${vB.tableName}`,
				columns,
				hasChanges: columns.some((c) => c.status !== 'unchanged')
			};
			return diff;
		}
	)

	// Execute rollback: run down_sql of a specific version
	.http(
		'db:schema:version:rollback',
		{
			data: t.Object({
				connectionId: t.String(),
				versionId: t.String()
			}),
			response: t.Object({
				ok: t.Boolean(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'schema:alter');

			const version = schemaVersionQueries.getById(data.versionId);
			if (!version) {
				return { ok: false, error: 'Version not found' };
			}
			if (version.connectionId !== data.connectionId) {
				return { ok: false, error: 'Version does not belong to this connection' };
			}
			if (version.status === 'rolled_back') {
				return { ok: false, error: 'This version has already been rolled back' };
			}
			if (!version.downStatements.length) {
				return { ok: false, error: 'No rollback SQL available for this version' };
			}

			const config = await getDecryptedConnection(data.connectionId);
			const { userId } = resolveIdentity(conn);
			const ip = ws.getRemoteAddress(conn);

			let userName = userId;
			try {
				const { authQueries } = await import('../../database/queries');
				userName = authQueries.getUserById(userId)?.name ?? userId;
			} catch {
				// ignore
			}

			try {
				const result = await applyAlterStatements(config, version.downStatements);

				dbRbacQueries.addAuditEntry({
					id: nanoid(),
					connectionId: data.connectionId,
					connectionName: config.name,
					userId,
					userName,
					action: 'schema:alter',
					sql: `-- ROLLBACK v${version.versionNumber}: ${version.tableName}\n${version.downStatements.join(';\n')}`,
					tableName: version.tableName,
					rowCount: null,
					executionTimeMs: null,
					success: result.ok,
					error: result.error ?? null,
					ipAddress: ip,
					performedAt: new Date().toISOString()
				});

				if (result.ok) {
					schemaVersionQueries.markRolledBack(version.id);

					// Record the rollback itself as a new version so history is append-only
					const rollbackVersionNumber = schemaVersionQueries.getNextVersionNumber(
						data.connectionId,
						version.tableName
					);
					schemaVersionQueries.add({
						id: nanoid(),
						connectionId: data.connectionId,
						connectionName: config.name,
						connectionType: config.type,
						tableName: version.tableName,
						schemaName: version.schemaName ?? undefined,
						versionNumber: rollbackVersionNumber,
						label: `Rollback of v${version.versionNumber}`,
						upStatements: version.downStatements,
						downStatements: version.upStatements,
						changes: [],
						columnsBefore: version.columnsAfter,
						columnsAfter: version.columnsBefore,
						appliedById: userId,
						appliedByName: userName,
						appliedAt: new Date().toISOString(),
						notes: `Automatic rollback of version ${version.versionNumber} (${version.label ?? version.appliedAt})`
					});
				}

				return result;
			} catch (err) {
				debug.error('database', 'Schema rollback error:', err);
				const errMsg = err instanceof Error ? err.message : 'Failed to execute rollback';

				dbRbacQueries.addAuditEntry({
					id: nanoid(),
					connectionId: data.connectionId,
					connectionName: config.name,
					userId,
					userName,
					action: 'schema:alter',
					sql: null,
					tableName: version.tableName,
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
	)

	// Update version label
	.http(
		'db:schema:version:label',
		{
			data: t.Object({ id: t.String(), label: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data, conn }) => {
			const version = schemaVersionQueries.getById(data.id);
			if (!version) return { ok: false };
			assertCan(conn, version.connectionId, 'connection:view');
			schemaVersionQueries.updateLabel(data.id, data.label);
			return { ok: true };
		}
	)

	// Export a version as SQL file content
	.http(
		'db:schema:version:export',
		{
			data: t.Object({
				id: t.String(),
				direction: t.Optional(t.Union([t.Literal('up'), t.Literal('down')]))
			}),
			response: t.Object({
				filename: t.String(),
				content: t.String()
			})
		},
		async ({ data, conn }) => {
			const version = schemaVersionQueries.getById(data.id);
			if (!version) {
				return { filename: 'not_found.sql', content: '-- Version not found' };
			}
			assertCan(conn, version.connectionId, 'connection:view');

			const direction = data.direction ?? 'up';
			const statements = direction === 'up' ? version.upStatements : version.downStatements;
			const dirLabel = direction === 'up' ? 'UP' : 'DOWN';
			const dateStr = new Date(version.appliedAt).toISOString().slice(0, 10);

			const content = [
				`-- Schema Version v${version.versionNumber} [${dirLabel}]`,
				`-- Table: ${version.tableName}`,
				`-- Connection: ${version.connectionName} (${version.connectionType})`,
				`-- Applied by: ${version.appliedByName} at ${version.appliedAt}`,
				version.label ? `-- Label: ${version.label}` : null,
				'',
				...statements.map((s) => `${s};`)
			]
				.filter((l) => l !== null)
				.join('\n');

			const safeName = version.tableName.replace(/[^a-z0-9_]/gi, '_');
			const filename = `schema_v${version.versionNumber}_${safeName}_${dateStr}_${direction}.sql`;

			return { filename, content };
		}
	)

	// Delete a version record (only for rolled_back versions)
	.http(
		'db:schema:version:delete',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean(), error: t.Optional(t.String()) })
		},
		async ({ data, conn }) => {
			const version = schemaVersionQueries.getById(data.id);
			if (!version) return { ok: false, error: 'Version not found' };
			assertCan(conn, version.connectionId, 'schema:alter');
			schemaVersionQueries.deleteById(data.id);
			return { ok: true };
		}
	);
