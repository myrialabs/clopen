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
import { dbLinks } from '../../db-client/integrations';
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
	connectionId: t.Optional(t.Nullable(t.String())),
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

/**
 * The fields a user may still change on a derived connection.
 *
 * A projection owns where the connection points and what it logs in with. The
 * colour is decoration, and the name is what the user calls it in their own
 * list — neither is derived from anything, so neither is taken away.
 */
function pickLocalFields(patch: Partial<DbClientConnectionInput>): Partial<DbClientConnectionInput> {
	const local: Partial<DbClientConnectionInput> = {};
	if (patch.name !== undefined) local.name = patch.name;
	if (patch.color !== undefined) local.color = patch.color;
	return local;
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
		// Ownership is attached HERE rather than stored on the connection: the
		// answer lives in `integration_projections`, and duplicating it into a
		// column would create a second place for it to be wrong.
		return dbLinks.decorate(dbClientConnectionQueries.listForUser(userId, isAdmin));
	})

	.http('db-client:get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data, conn }) => {
		const { userId, isAdmin } = getDbClientPrincipal(conn);
		const connection = dbClientConnectionQueries.getForUser(data.id, userId, isAdmin);
		if (!connection) throw new Error('db-client connection not found');
		return { ...connection, managedBy: dbLinks.managedBy(data.id) };
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
		// A managed row is DERIVED. Letting the form edit its host or password
		// would produce a connection the next re-projection silently reverts, so
		// the two fields that are genuinely local are the only ones allowed
		// through — everything else is changed by editing the link.
		const patch = (dbLinks.isManaged(data.id)
			? pickLocalFields(data.patch as Partial<DbClientConnectionInput>)
			: data.patch) as Partial<DbClientConnectionInput>;
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
		// Deleting a projected row here would leave the account owning a
		// connection that no longer exists, and the next re-projection would
		// recreate it — so the panel is told to unlink instead, which is the
		// operation that actually means "I do not want this connection".
		if (dbLinks.isManaged(data.id)) {
			throw new Error('This connection comes from a connected account. Unlink it there to remove it.');
		}
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
