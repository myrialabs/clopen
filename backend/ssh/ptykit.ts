/**
 * ssh-client — the PtyKit session engine for remote shells.
 *
 * A second `PtyKitManager` alongside the local-terminal one, differing only in
 * its injected backend (`sshPtyBackend`). Everything downstream — scrollback,
 * serialized reattach, collaborative rooms, reconnect — is PtyKit's.
 *
 * The namespace is `ssh:<connectionId>`: it scopes the collaborative room to a
 * single host and is what `authorize` checks ownership against. It is also the
 * only trustworthy statement of intent a client makes, so the tunnel derives the
 * spawn target from it rather than from anything else in the frame.
 */

import { PtyKitManager } from '@myrialabs/ptykit/core';
import { createPtyKitServer } from '@myrialabs/ptykit/server';
import { sshConnectionQueries } from '../database/queries';
import { sshPtyBackend } from './pty-backend';

const NAMESPACE_PREFIX = 'ssh:';

export function sshNamespaceFor(connectionId: string): string {
	return `${NAMESPACE_PREFIX}${connectionId}`;
}

/** The connection a namespace refers to, or null when it is not one of ours. */
export function connectionIdFromNamespace(namespace: string): string | null {
	if (!namespace.startsWith(NAMESPACE_PREFIX)) return null;
	const connectionId = namespace.slice(NAMESPACE_PREFIX.length);
	return connectionId || null;
}

/**
 * Remote shells outlive a browser refresh the same way local ones do, so the
 * settings mirror backend/terminal/ptykit.ts. Env injection is omitted: the
 * environment that matters belongs to the remote host, not to this process.
 */
export const sshPtyKitManager = new PtyKitManager({
	backend: sshPtyBackend,
	scrollback: 5000,
	idleTtl: null,
	retainExitedMs: 5 * 60_000
});

export const sshPtyKitServer = createPtyKitServer(sshPtyKitManager, {
	room: (ctx) => ctx.namespace,
	authorize: (ctx) => {
		const userId = ctx.conn.data.userId;
		const isAdmin = ctx.conn.data.isAdmin === true;
		if (typeof userId !== 'string' || !userId) return false;

		const connectionId = connectionIdFromNamespace(ctx.namespace);
		if (!connectionId) return false;

		return sshConnectionQueries.getForUser(connectionId, userId, isAdmin) !== null;
	}
});

/** Kill every shell open on a host. Used when its connection is edited or deleted. */
export function killSessionsForConnection(connectionId: string): number {
	let killed = 0;
	for (const session of sshPtyKitManager.list(sshNamespaceFor(connectionId))) {
		sshPtyKitManager.killSession(session.sessionId, 'SIGKILL');
		killed++;
	}
	return killed;
}
