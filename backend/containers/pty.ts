/**
 * Containers — the PtyKit session engine for shells inside containers.
 *
 * A third `PtyKitManager` alongside the local-terminal and SSH ones, differing
 * only in its injected backend. Everything downstream — scrollback, serialized
 * reattach, collaborative rooms, reconnect after a dropped socket — is PtyKit's
 * and is not reimplemented here.
 *
 * The namespace is `container:<hostId>:<containerId>`. That is the whole
 * security design: it is the only statement of intent the client makes,
 * `authorize` checks it, and the spawn target is derived from it rather than
 * from anything else in the frame — so a client cannot ask for a container on a
 * host it may not reach. It also scopes the collaborative room to one
 * container, which is what a second admin opening the same shell should join.
 *
 * A shell inside a container is usually root inside it and can reach every
 * volume that container mounts, so `authorize` requires an admin. Reading the
 * list, the detail and the logs stays open to any member.
 */

import { PtyKitManager } from '@myrialabs/ptykit/core';
import { createPtyKitServer } from '@myrialabs/ptykit/server';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { sshConnectionQueries } from '../database/queries';
import { containerPtyBackend } from './pty-backend';
import { isContainerId } from './actions';

const NAMESPACE_PREFIX = 'container:';

export function containerNamespaceFor(hostId: string, containerId: string): string {
	return `${NAMESPACE_PREFIX}${hostId}:${containerId}`;
}

/** The target a namespace refers to, or null when it is not one of ours. */
export function targetFromNamespace(
	namespace: string
): { hostId: string; containerId: string } | null {
	if (!namespace.startsWith(NAMESPACE_PREFIX)) return null;
	const rest = namespace.slice(NAMESPACE_PREFIX.length);
	const split = rest.lastIndexOf(':');
	if (split <= 0) return null;

	const hostId = rest.slice(0, split);
	const containerId = rest.slice(split + 1);
	if (!hostId || !isContainerId(containerId)) return null;
	return { hostId, containerId };
}

/**
 * Container shells outlive a browser refresh the same way local and remote
 * ones do, so the settings mirror the other two managers. Env injection is
 * omitted: the environment that matters belongs to the container, not to this
 * process.
 */
export const containerPtyKitManager = new PtyKitManager({
	backend: containerPtyBackend,
	scrollback: 5000,
	idleTtl: null,
	retainExitedMs: 5 * 60_000
});

export const containerPtyKitServer = createPtyKitServer(containerPtyKitManager, {
	room: (ctx) => ctx.namespace,
	authorize: (ctx) => {
		const userId = ctx.conn.data.userId;
		const isAdmin = ctx.conn.data.isAdmin === true;
		if (typeof userId !== 'string' || !userId) return false;
		// A container shell can do anything the container can, so it is gated the
		// same way stopping a port is.
		if (!isAdmin) return false;

		const target = targetFromNamespace(ctx.namespace);
		if (!target) return false;
		if (target.hostId === LOCAL_HOST_ID) return true;

		return sshConnectionQueries.getForUser(target.hostId, userId, isAdmin) !== null;
	}
});

/** Kill every container shell open on a host. */
export function killContainerSessionsForHost(hostId: string): number {
	let killed = 0;
	const prefix = `${NAMESPACE_PREFIX}${hostId}:`;
	// PtyKit lists per namespace and a namespace names one container, so every
	// container that has a shell open on this host is asked in turn.
	for (const namespace of listNamespaces()) {
		if (!namespace.startsWith(prefix)) continue;
		for (const session of containerPtyKitManager.list(namespace)) {
			containerPtyKitManager.killSession(session.sessionId, 'SIGKILL');
			killed++;
		}
	}
	return killed;
}

/**
 * Namespaces with at least one live session.
 *
 * PtyKit's manager lists sessions per namespace and does not enumerate the
 * namespaces themselves, so they are tracked here as sessions are created —
 * which is also what lets a host-wide teardown find them.
 */
const namespaces = new Set<string>();

export function rememberNamespace(namespace: string): void {
	if (targetFromNamespace(namespace)) namespaces.add(namespace);
}

function listNamespaces(): string[] {
	for (const namespace of [...namespaces]) {
		if (containerPtyKitManager.list(namespace).length === 0) namespaces.delete(namespace);
	}
	return [...namespaces];
}
