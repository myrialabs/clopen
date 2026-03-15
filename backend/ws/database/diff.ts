/**
 * Database Manager - Diff Handler
 * Compares schemas between two connections and generates migration scripts.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { assertCan } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { compareSchemas, generateMigrationScript, splitMigrationStatements } from '../../db-manager/diff';
import { applyAlterStatements } from '../../db-manager';
import { debug } from '$shared/utils/logger';

// ─── Elysia Schemas ───────────────────────────────────────────────────────────

const DBColumnSchema = t.Object({
	name: t.String(),
	type: t.String(),
	nullable: t.Boolean(),
	primaryKey: t.Boolean(),
	unique: t.Optional(t.Boolean()),
	defaultValue: t.Optional(t.Union([t.String(), t.Null()]))
});

const DBIndexInfoSchema = t.Object({
	name: t.String(),
	columns: t.Array(t.String()),
	unique: t.Boolean(),
	primary: t.Boolean()
});

const DiffStatusSchema = t.Union([
	t.Literal('added'),
	t.Literal('removed'),
	t.Literal('modified'),
	t.Literal('unchanged')
]);

const DBColumnDiffSchema = t.Object({
	name: t.String(),
	status: DiffStatusSchema,
	source: t.Union([DBColumnSchema, t.Null()]),
	target: t.Union([DBColumnSchema, t.Null()])
});

const DBIndexDiffSchema = t.Object({
	name: t.String(),
	status: DiffStatusSchema,
	source: t.Union([DBIndexInfoSchema, t.Null()]),
	target: t.Union([DBIndexInfoSchema, t.Null()])
});

const DBTableDiffSchema = t.Object({
	tableName: t.String(),
	schema: t.Optional(t.String()),
	status: DiffStatusSchema,
	columns: t.Array(DBColumnDiffSchema),
	indexes: t.Array(DBIndexDiffSchema)
});

const DBSchemaDiffSchema = t.Object({
	sourceConnectionId: t.String(),
	targetConnectionId: t.String(),
	sourceConnectionName: t.String(),
	targetConnectionName: t.String(),
	tables: t.Array(DBTableDiffSchema),
	hasDifferences: t.Boolean(),
	summary: t.Object({
		tablesAdded: t.Number(),
		tablesRemoved: t.Number(),
		tablesModified: t.Number(),
		columnsAdded: t.Number(),
		columnsRemoved: t.Number(),
		columnsModified: t.Number(),
		indexesAdded: t.Number(),
		indexesRemoved: t.Number()
	})
});

const MigrationScriptSchema = t.Object({
	up: t.String(),
	down: t.String(),
	warnings: t.Array(t.String())
});

// ─── Handler ──────────────────────────────────────────────────────────────────

export const diffHandler = createRouter()
	// Compare schemas between two connections
	.http(
		'db:diff:compare',
		{
			data: t.Object({
				sourceConnectionId: t.String(),
				targetConnectionId: t.String()
			}),
			response: DBSchemaDiffSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.sourceConnectionId, 'connection:view');
			assertCan(conn, data.targetConnectionId, 'connection:view');
			const [sourceConfig, targetConfig] = await Promise.all([
				getDecryptedConnection(data.sourceConnectionId),
				getDecryptedConnection(data.targetConnectionId)
			]);
			return compareSchemas(sourceConfig, targetConfig);
		}
	)

	// Generate UP/DOWN migration script from a schema diff
	.http(
		'db:diff:generate',
		{
			data: t.Object({
				sourceConnectionId: t.String(),
				targetConnectionId: t.String()
			}),
			response: MigrationScriptSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.sourceConnectionId, 'connection:view');
			assertCan(conn, data.targetConnectionId, 'connection:view');
			const [sourceConfig, targetConfig] = await Promise.all([
				getDecryptedConnection(data.sourceConnectionId),
				getDecryptedConnection(data.targetConnectionId)
			]);
			const diff = await compareSchemas(sourceConfig, targetConfig);
			return generateMigrationScript(diff, targetConfig.type);
		}
	)

	// Apply UP migration script to the target connection
	.http(
		'db:diff:apply',
		{
			data: t.Object({
				sourceConnectionId: t.String(),
				targetConnectionId: t.String()
			}),
			response: t.Object({
				ok: t.Boolean(),
				appliedCount: t.Number(),
				error: t.Optional(t.String())
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.sourceConnectionId, 'connection:view');
			assertCan(conn, data.targetConnectionId, 'schema:alter');
			try {
				const [sourceConfig, targetConfig] = await Promise.all([
					getDecryptedConnection(data.sourceConnectionId),
					getDecryptedConnection(data.targetConnectionId)
				]);
				const diff = await compareSchemas(sourceConfig, targetConfig);
				const migration = generateMigrationScript(diff, targetConfig.type);
				const statements = splitMigrationStatements(migration.up);
				if (!statements.length) return { ok: true, appliedCount: 0 };
				const result = await applyAlterStatements(targetConfig, statements);
				return { ok: result.ok, appliedCount: result.ok ? statements.length : 0, error: result.error };
			} catch (err) {
				debug.error('database', 'Diff apply error:', err);
				return { ok: false, appliedCount: 0, error: err instanceof Error ? err.message : 'Apply failed' };
			}
		}
	);
