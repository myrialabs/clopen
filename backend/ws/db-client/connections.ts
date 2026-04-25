/**
 * db-client — connection CRUD + health WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { dbClientConnectionQueries } from '../../database/queries';
import { connectionManager } from '../../db-client/connection-manager';
import type {
	DbClientConnectionInput,
	DbDriver,
	DbSshAuthMethod,
	DbSslMode
} from '$shared/types/db-client';
import { debug } from '$shared/utils/logger';

const driverSchema = t.Union([
	t.Literal('mysql'),
	t.Literal('postgres'),
	t.Literal('sqlite'),
	t.Literal('mongodb'),
	t.Literal('redis')
]);

const sslModeSchema = t.Union([
	t.Literal('disable'),
	t.Literal('require'),
	t.Literal('verify-ca'),
	t.Literal('verify-full')
]);

const sshAuthSchema = t.Union([t.Literal('password'), t.Literal('key')]);

const sshInputSchema = t.Object({
	enabled: t.Optional(t.Boolean()),
	host: t.Optional(t.String()),
	port: t.Optional(t.Number()),
	username: t.Optional(t.String()),
	authMethod: t.Optional(sshAuthSchema),
	password: t.Optional(t.String()),
	privateKey: t.Optional(t.String()),
	passphrase: t.Optional(t.String())
});

const connectionInputSchema = t.Object({
	name: t.String({ minLength: 1 }),
	driver: driverSchema,
	host: t.Optional(t.String()),
	port: t.Optional(t.Number()),
	username: t.Optional(t.String()),
	password: t.Optional(t.String()),
	database: t.Optional(t.String()),
	sslMode: t.Optional(sslModeSchema),
	sslCa: t.Optional(t.String()),
	ssh: t.Optional(sshInputSchema),
	options: t.Optional(t.Record(t.String(), t.Any())),
	color: t.Optional(t.String())
});

const connectionPatchSchema = t.Object({
	name: t.Optional(t.String({ minLength: 1 })),
	driver: t.Optional(driverSchema),
	host: t.Optional(t.String()),
	port: t.Optional(t.Number()),
	username: t.Optional(t.String()),
	password: t.Optional(t.String()),
	database: t.Optional(t.String()),
	sslMode: t.Optional(sslModeSchema),
	sslCa: t.Optional(t.String()),
	ssh: t.Optional(sshInputSchema),
	options: t.Optional(t.Record(t.String(), t.Any())),
	color: t.Optional(t.String())
});

const healthSchema = t.Object({
	ok: t.Boolean(),
	latencyMs: t.Nullable(t.Number()),
	serverVersion: t.Nullable(t.String()),
	sshOk: t.Nullable(t.Boolean()),
	error: t.Nullable(t.String())
});

const connectionTestSchema = t.Union([
	t.Object({ id: t.String({ minLength: 1 }) }),
	connectionInputSchema
]);

function isInput(v: unknown): v is DbClientConnectionInput {
	return typeof v === 'object' && v !== null && 'driver' in (v as Record<string, unknown>);
}

function normalizeSshPatch(input: DbClientConnectionInput['ssh']): DbClientConnectionInput['ssh'] {
	if (!input) return undefined;
	return {
		...input,
		authMethod: (input.authMethod ?? 'password') as DbSshAuthMethod
	};
}

function ensureInputDefaults(input: DbClientConnectionInput): DbClientConnectionInput {
	return {
		...input,
		driver: input.driver as DbDriver,
		sslMode: (input.sslMode ?? 'disable') as DbSslMode,
		ssh: normalizeSshPatch(input.ssh)
	};
}

export const connectionsHandler = createRouter()
	.http('db-client:list', {
		data: t.Object({}),
		response: t.Array(t.Any())
	}, async () => {
		await initializeDatabase();
		return dbClientConnectionQueries.list();
	})

	.http('db-client:get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => {
		const conn = dbClientConnectionQueries.get(data.id);
		if (!conn) throw new Error('db-client connection not found');
		return conn;
	})

	.http('db-client:create', {
		data: connectionInputSchema,
		response: t.Any()
	}, async ({ data }) => {
		await initializeDatabase();
		const conn = dbClientConnectionQueries.create(ensureInputDefaults(data as DbClientConnectionInput));
		debug.log('db-client', `created connection ${conn.id} (${conn.driver})`);
		return conn;
	})

	.http('db-client:update', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			patch: connectionPatchSchema
		}),
		response: t.Any()
	}, async ({ data }) => {
		const patch = data.patch as Partial<DbClientConnectionInput>;
		const normalized: Partial<DbClientConnectionInput> = {
			...patch,
			ssh: patch.ssh ? normalizeSshPatch(patch.ssh) : undefined
		};
		// Drop the live adapter so the next access re-opens with new settings.
		await connectionManager.release(data.id);
		return dbClientConnectionQueries.update(data.id, normalized);
	})

	.http('db-client:delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		await connectionManager.release(data.id);
		dbClientConnectionQueries.delete(data.id);
		return { ok: true };
	})

	.http('db-client:test', {
		data: connectionTestSchema,
		response: healthSchema
	}, async ({ data }) => {
		await initializeDatabase();
		if (isInput(data)) {
			return connectionManager.test(ensureInputDefaults(data as DbClientConnectionInput));
		}
		return connectionManager.test({ id: (data as { id: string }).id });
	})

	.http('db-client:health', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: healthSchema
	}, async ({ data }) => {
		return connectionManager.test({ id: data.id });
	});
