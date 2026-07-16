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
import { getDbClientPrincipal, requireDbClientConnectionAccess } from './access';

const driverSchema = t.Union([
	t.Literal('mysql'),
	t.Literal('postgres'),
	t.Literal('sqlite'),
	t.Literal('mongodb'),
	t.Literal('redis'),
	t.Literal('mssql')
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
	}, async ({ conn }) => {
		await initializeDatabase();
		const { userId, isAdmin } = getDbClientPrincipal(conn);
		return dbClientConnectionQueries.listForUser(userId, isAdmin);
	})

	.http('db-client:get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		const { userId, isAdmin } = getDbClientPrincipal(conn);
		const connection = dbClientConnectionQueries.getForUser(data.id, userId, isAdmin);
		if (!connection) throw new Error('db-client connection not found');
		return connection;
	})

	.http('db-client:create', {
		data: connectionInputSchema,
		response: t.Any()
	}, async ({ data, conn }) => {
		await initializeDatabase();
		const { userId } = getDbClientPrincipal(conn);
		const created = dbClientConnectionQueries.createForUser(
			ensureInputDefaults(data as DbClientConnectionInput),
			userId
		);
		debug.log('db-client', `created connection ${created.id} (${created.driver})`);
		return created;
	})

	.http('db-client:update', {
		data: t.Object({
			id: t.String({ minLength: 1 }),
			patch: connectionPatchSchema
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const { userId, isAdmin } = getDbClientPrincipal(conn);
		requireDbClientConnectionAccess(conn, data.id);
		const patch = data.patch as Partial<DbClientConnectionInput>;
		const normalized: Partial<DbClientConnectionInput> = {
			...patch,
			ssh: patch.ssh ? normalizeSshPatch(patch.ssh) : undefined
		};
		// Drop the live adapter so the next access re-opens with new settings.
		await connectionManager.release(data.id);
		return dbClientConnectionQueries.updateForUser(data.id, normalized, userId, isAdmin);
	})

	.http('db-client:delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data, conn }) => {
		const { userId, isAdmin } = getDbClientPrincipal(conn);
		requireDbClientConnectionAccess(conn, data.id);
		await connectionManager.release(data.id);
		dbClientConnectionQueries.deleteForUser(data.id, userId, isAdmin);
		return { ok: true };
	})

	.http('db-client:test', {
		data: connectionTestSchema,
		response: healthSchema
	}, async ({ data, conn }) => {
		await initializeDatabase();
		if (isInput(data)) {
			return connectionManager.test(ensureInputDefaults(data as DbClientConnectionInput));
		}
		const id = (data as { id: string }).id;
		requireDbClientConnectionAccess(conn, id);
		return connectionManager.test({ id });
	})

	.http('db-client:health', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: healthSchema
	}, async ({ data, conn }) => {
		requireDbClientConnectionAccess(conn, data.id);
		return connectionManager.test({ id: data.id });
	});
