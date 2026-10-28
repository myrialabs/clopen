/**
 * ssh-client — connection CRUD, health and host-key trust WS handlers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { initializeDatabase } from '../../database';
import { sshConnectionQueries, sshKnownHostQueries } from '../../database/queries';
import { sshClientPool } from '../../ssh/client-pool';
import { sshForwardManager } from '../../ssh/forwards';
import { sshHealthService } from '../../ssh/health';
import { knownHosts } from '../../ssh/known-hosts';
import { killSessionsForConnection } from '../../ssh/ptykit';
import { killContainerSessionsForHost } from '../../containers/pty';
import { stopLogStreamsForHost } from '../../containers/logs';
import type { SshConnectionInput } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';
import { requireSshConnection } from './access';

const authMethodSchema = t.Union([
	t.Literal('password'),
	t.Literal('key'),
	t.Literal('key-file'),
	t.Literal('agent')
]);

const connectionInputSchema = t.Object({
	name: t.String({ minLength: 1 }),
	host: t.String({ minLength: 1 }),
	port: t.Optional(t.Number()),
	username: t.String({ minLength: 1 }),
	authMethod: t.Optional(authMethodSchema),
	password: t.Optional(t.String()),
	privateKey: t.Optional(t.String()),
	privateKeyPath: t.Optional(t.String()),
	passphrase: t.Optional(t.String()),
	agentSocket: t.Optional(t.String()),
	jumpConnectionId: t.Optional(t.Nullable(t.String())),
	initialPath: t.Optional(t.String()),
	keepaliveSeconds: t.Optional(t.Number()),
	strictHostKey: t.Optional(t.Boolean()),
	color: t.Optional(t.String())
});

const connectionPatchSchema = t.Object({
	name: t.Optional(t.String({ minLength: 1 })),
	host: t.Optional(t.String({ minLength: 1 })),
	port: t.Optional(t.Number()),
	username: t.Optional(t.String({ minLength: 1 })),
	authMethod: t.Optional(authMethodSchema),
	password: t.Optional(t.String()),
	privateKey: t.Optional(t.String()),
	privateKeyPath: t.Optional(t.String()),
	passphrase: t.Optional(t.String()),
	agentSocket: t.Optional(t.String()),
	jumpConnectionId: t.Optional(t.Nullable(t.String())),
	initialPath: t.Optional(t.String()),
	keepaliveSeconds: t.Optional(t.Number()),
	strictHostKey: t.Optional(t.Boolean()),
	color: t.Optional(t.String())
});

const healthSchema = t.Object({
	ok: t.Boolean(),
	latencyMs: t.Nullable(t.Number()),
	serverBanner: t.Nullable(t.String()),
	remoteOs: t.Nullable(t.String()),
	hostKeyFingerprint: t.Nullable(t.String()),
	hostKeyChanged: t.Boolean(),
	suspended: t.Boolean(),
	error: t.Nullable(t.String())
});

const connectionTestSchema = t.Union([t.Object({ id: t.String({ minLength: 1 }) }), connectionInputSchema]);

function isInput(value: unknown): value is SshConnectionInput {
	return typeof value === 'object' && value !== null && 'host' in (value as Record<string, unknown>);
}

/**
 * Changing where or how a host is reached invalidates everything riding the old
 * transport, so shells, forwards and the pooled client all go before the write.
 * That includes the two things this host's containers hold open: shells running
 * inside them, and any log stream being followed.
 */
async function tearDownConnection(connectionId: string): Promise<void> {
	killSessionsForConnection(connectionId);
	killContainerSessionsForHost(connectionId);
	stopLogStreamsForHost(connectionId);
	await sshForwardManager.stopForConnection(connectionId);
	sshClientPool.release(connectionId);
	// Editing or deleting is not "disconnect" — a host suspended earlier should
	// be dialable again once its settings change.
	sshClientPool.resume(connectionId);
}

export const sshConnectionsHandler = createRouter()
	.http('ssh:list', {
		data: t.Object({}),
		response: t.Array(t.Any())
	}, async () => {
		await initializeDatabase();
		return sshConnectionQueries.listRedacted();
	})

	.http('ssh:get', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Any()
	}, async ({ data }) => {
		const connection = sshConnectionQueries.getRedacted(data.id);
		if (!connection) throw new Error('ssh connection not found');
		return connection;
	})

	.http('ssh:create', {
		data: connectionInputSchema,
		response: t.Any()
	}, async ({ data }) => {
		await initializeDatabase();
		const created = sshConnectionQueries.createRedacted(data as SshConnectionInput);
		debug.log('ssh', `created connection ${created.id} (${created.host})`);
		return created;
	})

	.http('ssh:update', {
		data: t.Object({ id: t.String({ minLength: 1 }), patch: connectionPatchSchema }),
		response: t.Any()
	}, async ({ data }) => {
		requireSshConnection(data.id);
		await tearDownConnection(data.id);
		return sshConnectionQueries.updateRedacted(data.id, data.patch as Partial<SshConnectionInput>);
	})

	.http('ssh:delete', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		requireSshConnection(data.id);
		await tearDownConnection(data.id);
		sshConnectionQueries.delete(data.id);
		return { ok: true };
	})

	.http('ssh:test', {
		data: connectionTestSchema,
		response: healthSchema
	}, async ({ data }) => {
		await initializeDatabase();
		if (isInput(data)) {
			return sshHealthService.testInput(data as SshConnectionInput);
		}
		const id = (data as { id: string }).id;
		requireSshConnection(id);
		return sshHealthService.testSaved(id);
	})

	/**
	 * Open the host now (and start its auto-start forwards). Called when the user
	 * selects a connection, so the sidebar can show a live state before any tab
	 * or file listing asks for one.
	 */
	.http('ssh:activate', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: healthSchema
	}, async ({ data }) => {
		requireSshConnection(data.id);
		sshClientPool.resume(data.id);
		const health = await sshHealthService.testSaved(data.id);
		if (health.ok) {
			await sshForwardManager.startAutoForwards(data.id);
		}
		return health;
	})

	/**
	 * Close a host's transport, its shells and its forwards, and keep it closed.
	 * Without the suspend the pool would redial on the next keystroke, which is
	 * what made this button look like it did nothing.
	 */
	.http('ssh:disconnect', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: healthSchema
	}, async ({ data }) => {
		requireSshConnection(data.id);
		killSessionsForConnection(data.id);
		killContainerSessionsForHost(data.id);
		stopLogStreamsForHost(data.id);
		await sshForwardManager.stopForConnection(data.id);
		sshClientPool.suspend(data.id);
		return sshHealthService.testSaved(data.id);
	})

	.http('ssh:known-hosts', {
		data: t.Object({}),
		response: t.Array(t.Any())
	}, async () => {
		await initializeDatabase();
		return sshKnownHostQueries.list();
	})

	/**
	 * Accept the key a host is presenting now, replacing the trusted one. The
	 * fingerprint is re-read from the live handshake rather than taken from the
	 * client, so trusting is always trusting what the host actually sent.
	 */
	.http('ssh:trust-host-key', {
		data: t.Object({ id: t.String({ minLength: 1 }) }),
		response: healthSchema
	}, async ({ data }) => {
		const connection = requireSshConnection(data.id);
		knownHosts.forget(connection.host, connection.port);
		await tearDownConnection(data.id);
		return sshHealthService.testSaved(data.id);
	})

	.http('ssh:forget-host-key', {
		data: t.Object({ host: t.String({ minLength: 1 }), port: t.Number() }),
		response: t.Object({ ok: t.Boolean() })
	}, async ({ data }) => {
		knownHosts.forget(data.host, data.port);
		return { ok: true };
	});
