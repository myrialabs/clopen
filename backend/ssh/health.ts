/**
 * ssh-client — the "does this host actually work" probe behind the Test button.
 *
 * A saved connection is probed on its pooled transport so Test doubles as a
 * live status check. Unsaved form input is dialed once and dropped, which is
 * what makes Test useful before the first save.
 */

import type { Client as SshClient } from 'ssh2';
import { sshConnectionQueries } from '../database/queries';
import { sshClientPool } from './client-pool';
import { closeChain, dial, HostKeyChangedError, runCommand } from './connect';
import { knownHosts } from './known-hosts';
import type { SshConnection, SshConnectionInput, SshHealth } from '$shared/types/ssh';
import { debug } from '$shared/utils/logger';

function failure(error: unknown, hostKeyFingerprint: string | null): SshHealth {
	const changed = error instanceof HostKeyChangedError;
	return {
		ok: false,
		latencyMs: null,
		serverBanner: null,
		remoteOs: null,
		hostKeyFingerprint: changed ? error.verdict.identity.fingerprint : hostKeyFingerprint,
		hostKeyChanged: changed,
		suspended: false,
		error: error instanceof Error ? error.message : String(error)
	};
}

/** Shape unsaved form input as a connection so one dial path serves both. */
export function inputToConnection(input: SshConnectionInput): SshConnection {
	const now = new Date().toISOString();
	return {
		id: 'transient',
		name: input.name,
		host: input.host,
		port: input.port ?? 22,
		username: input.username,
		authMethod: input.authMethod ?? 'password',
		password: input.password ?? null,
		privateKey: input.privateKey ?? null,
		privateKeyPath: input.privateKeyPath ?? null,
		passphrase: input.passphrase ?? null,
		agentSocket: input.agentSocket ?? null,
		jumpConnectionId: input.jumpConnectionId ?? null,
		initialPath: input.initialPath ?? null,
		keepaliveSeconds: input.keepaliveSeconds ?? 30,
		strictHostKey: input.strictHostKey !== false,
		color: input.color ?? null,
		createdAt: now,
		updatedAt: now,
		lastUsedAt: null
	};
}

/** `uname -sr`, best effort — a host that refuses `exec` still counts as healthy. */
async function probeRemoteOs(client: SshClient): Promise<string | null> {
	try {
		const output = await runCommand(client, 'uname -sr');
		return output || null;
	} catch {
		return null;
	}
}

async function testTransient(connection: SshConnection): Promise<SshHealth> {
	const known = knownHosts.find(connection.host, connection.port);
	const startedAt = Date.now();
	let dialed = null;
	try {
		dialed = await dial(connection);
		const latencyMs = Date.now() - startedAt;
		const remoteOs = await probeRemoteOs(dialed.client);
		return {
			ok: true,
			latencyMs,
			serverBanner: dialed.serverBanner,
			remoteOs,
			hostKeyFingerprint: dialed.hostKey.identity.fingerprint,
			hostKeyChanged: false,
			suspended: false,
			error: null
		};
	} catch (error) {
		debug.warn('ssh', `test failed for ${connection.host}: ${error instanceof Error ? error.message : error}`);
		return failure(error, known?.fingerprint ?? null);
	} finally {
		if (dialed) closeChain(dialed.chain);
	}
}

export const sshHealthService = {
	/** Probe a saved host over its pooled transport. */
	async testSaved(connectionId: string): Promise<SshHealth> {
		const connection = sshConnectionQueries.get(connectionId);
		if (!connection) {
			return failure(new Error('ssh connection not found'), null);
		}
		// A host the user disconnected is reported as such rather than redialed —
		// probing it would defeat the Disconnect button.
		if (sshClientPool.isSuspended(connectionId)) {
			return {
				ok: false,
				latencyMs: null,
				serverBanner: null,
				remoteOs: null,
				hostKeyFingerprint: knownHosts.find(connection.host, connection.port)?.fingerprint ?? null,
				hostKeyChanged: false,
				suspended: true,
				error: null
			};
		}

		const known = knownHosts.find(connection.host, connection.port);
		const startedAt = Date.now();
		try {
			return await sshClientPool.use(connectionId, async (client) => {
				const latencyMs = Date.now() - startedAt;
				const remoteOs = await probeRemoteOs(client);
				return {
					ok: true,
					latencyMs,
					serverBanner: null,
					remoteOs,
					hostKeyFingerprint: knownHosts.find(connection.host, connection.port)?.fingerprint ?? null,
					hostKeyChanged: false,
					suspended: false,
					error: null
				};
			});
		} catch (error) {
			return failure(error, known?.fingerprint ?? null);
		}
	},

	/** Probe unsaved form input, without touching the pool. */
	testInput(input: SshConnectionInput): Promise<SshHealth> {
		return testTransient(inputToConnection(input));
	}
};
