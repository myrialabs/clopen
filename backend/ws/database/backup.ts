/**
 * Database Manager - Automated Backup Handlers
 * CRUD for backup configurations and manual backup triggering.
 */

import { t } from 'elysia';
import { nanoid } from 'nanoid';
import { createRouter } from '$shared/utils/ws-server';
import { dbBackupQueries } from '../../database/queries/db-backup-queries';
import { assertCan } from '../../db-manager/rbac';
import { getDecryptedConnection } from './connections';
import { runBackup } from '../../db-manager/backup';
import { encrypt } from '../../db-manager/crypto';
import type { BackupConfig } from '$shared/types/db-export';

// ─── Elysia schemas ───────────────────────────────────────────────────────────

const BackupConfigSchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	name: t.String(),
	enabled: t.Boolean(),
	provider: t.Union([t.Literal('aws-s3'), t.Literal('gcs')]),
	frequency: t.Union([
		t.Literal('hourly'),
		t.Literal('daily'),
		t.Literal('weekly'),
		t.Literal('monthly')
	]),
	hour: t.Number(),
	dayOfWeek: t.Optional(t.Number()),
	dayOfMonth: t.Optional(t.Number()),
	bucket: t.String(),
	prefix: t.String(),
	awsRegion: t.Optional(t.String()),
	awsAccessKeyId: t.Optional(t.String()),
	awsSecretAccessKey: t.Optional(t.String()),
	gcsProjectId: t.Optional(t.String()),
	gcsClientEmail: t.Optional(t.String()),
	gcsPrivateKey: t.Optional(t.String()),
	retentionDays: t.Number(),
	lastRunAt: t.Optional(t.String()),
	lastRunSuccess: t.Optional(t.Boolean()),
	lastRunError: t.Optional(t.String()),
	createdAt: t.String(),
	updatedAt: t.String()
});

const BackupRunSchema = t.Object({
	id: t.String(),
	configId: t.String(),
	connectionId: t.String(),
	connectionName: t.String(),
	startedAt: t.String(),
	completedAt: t.Optional(t.String()),
	success: t.Boolean(),
	fileSize: t.Optional(t.Number()),
	storagePath: t.Optional(t.String()),
	error: t.Optional(t.String())
});

/** Mask sensitive credentials in config for the client response */
function sanitizeConfig(config: BackupConfig): BackupConfig {
	return {
		...config,
		awsSecretAccessKey: config.awsSecretAccessKey ? '••••••••' : undefined,
		gcsPrivateKey: config.gcsPrivateKey ? '••••••••' : undefined
	};
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export const backupHandler = createRouter()
	// List backup configs for a connection
	.http(
		'db:backup:list',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Array(BackupConfigSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			return dbBackupQueries.listForConnection(data.connectionId).map(sanitizeConfig);
		}
	)

	// Create a backup config
	.http(
		'db:backup:create',
		{
			data: t.Object({
				connectionId: t.String(),
				name: t.String({ minLength: 1 }),
				enabled: t.Boolean(),
				provider: t.Union([t.Literal('aws-s3'), t.Literal('gcs')]),
				frequency: t.Union([
					t.Literal('hourly'),
					t.Literal('daily'),
					t.Literal('weekly'),
					t.Literal('monthly')
				]),
				hour: t.Number({ minimum: 0, maximum: 23 }),
				dayOfWeek: t.Optional(t.Number({ minimum: 0, maximum: 6 })),
				dayOfMonth: t.Optional(t.Number({ minimum: 1, maximum: 31 })),
				bucket: t.String({ minLength: 1 }),
				prefix: t.String(),
				awsRegion: t.Optional(t.String()),
				awsAccessKeyId: t.Optional(t.String()),
				awsSecretAccessKey: t.Optional(t.String()),
				gcsProjectId: t.Optional(t.String()),
				gcsClientEmail: t.Optional(t.String()),
				gcsPrivateKey: t.Optional(t.String()),
				retentionDays: t.Number({ minimum: 1, maximum: 365 })
			}),
			response: BackupConfigSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:update');
			const now = new Date().toISOString();

			// Encrypt sensitive credentials before storage
			const awsSecret = data.awsSecretAccessKey ? await encrypt(data.awsSecretAccessKey) : undefined;
			const gcsKey = data.gcsPrivateKey ? await encrypt(data.gcsPrivateKey) : undefined;

			const config: BackupConfig = {
				id: nanoid(),
				...data,
				awsSecretAccessKey: awsSecret,
				gcsPrivateKey: gcsKey,
				prefix: data.prefix || 'clopen-backups/',
				createdAt: now,
				updatedAt: now
			};

			dbBackupQueries.create(config);
			return sanitizeConfig(config);
		}
	)

	// Update a backup config
	.http(
		'db:backup:update',
		{
			data: t.Object({
				id: t.String(),
				connectionId: t.String(),
				name: t.Optional(t.String()),
				enabled: t.Optional(t.Boolean()),
				provider: t.Optional(t.Union([t.Literal('aws-s3'), t.Literal('gcs')])),
				frequency: t.Optional(
					t.Union([
						t.Literal('hourly'),
						t.Literal('daily'),
						t.Literal('weekly'),
						t.Literal('monthly')
					])
				),
				hour: t.Optional(t.Number({ minimum: 0, maximum: 23 })),
				dayOfWeek: t.Optional(t.Number({ minimum: 0, maximum: 6 })),
				dayOfMonth: t.Optional(t.Number({ minimum: 1, maximum: 31 })),
				bucket: t.Optional(t.String()),
				prefix: t.Optional(t.String()),
				awsRegion: t.Optional(t.String()),
				awsAccessKeyId: t.Optional(t.String()),
				awsSecretAccessKey: t.Optional(t.String()),
				gcsProjectId: t.Optional(t.String()),
				gcsClientEmail: t.Optional(t.String()),
				gcsPrivateKey: t.Optional(t.String()),
				retentionDays: t.Optional(t.Number({ minimum: 1, maximum: 365 }))
			}),
			response: BackupConfigSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:update');

			const updates: Partial<BackupConfig> = { ...data };
			delete (updates as Record<string, unknown>)['id'];
			delete (updates as Record<string, unknown>)['connectionId'];

			// Encrypt new credentials if provided
			if (data.awsSecretAccessKey && data.awsSecretAccessKey !== '••••••••') {
				updates.awsSecretAccessKey = await encrypt(data.awsSecretAccessKey);
			} else {
				delete updates.awsSecretAccessKey;
			}
			if (data.gcsPrivateKey && data.gcsPrivateKey !== '••••••••') {
				updates.gcsPrivateKey = await encrypt(data.gcsPrivateKey);
			} else {
				delete updates.gcsPrivateKey;
			}

			dbBackupQueries.update(data.id, updates);

			const updated = dbBackupQueries.getById(data.id);
			if (!updated) throw new Error('Backup config not found after update');
			return sanitizeConfig(updated);
		}
	)

	// Delete a backup config
	.http(
		'db:backup:delete',
		{
			data: t.Object({ id: t.String(), connectionId: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:update');
			dbBackupQueries.delete(data.id);
			return { ok: true };
		}
	)

	// Manually trigger a backup now
	.http(
		'db:backup:run',
		{
			data: t.Object({ id: t.String(), connectionId: t.String() }),
			response: BackupRunSchema
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:update');

			const config = dbBackupQueries.getById(data.id);
			if (!config) throw new Error('Backup config not found');

			const dbConfig = await getDecryptedConnection(data.connectionId);
			const run = await runBackup(config, dbConfig);

			dbBackupQueries.addRun(run);
			dbBackupQueries.update(config.id, {
				lastRunAt: run.startedAt,
				lastRunSuccess: run.success,
				lastRunError: run.error
			});

			return run;
		}
	)

	// Get backup run history for a config
	.http(
		'db:backup:history',
		{
			data: t.Object({
				configId: t.String(),
				connectionId: t.String(),
				limit: t.Optional(t.Number({ minimum: 1, maximum: 200 }))
			}),
			response: t.Array(BackupRunSchema)
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'connection:view');
			return dbBackupQueries.getRuns(data.configId, data.limit ?? 50);
		}
	);
