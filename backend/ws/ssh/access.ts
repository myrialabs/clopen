import type { WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { sshConnectionQueries } from '../../database/queries';
import { sshPortForwardQueries } from '../../database/queries';
import type { SshConnection, SshForward } from '$shared/types/ssh';

export interface SshPrincipal {
	userId: string;
	isAdmin: boolean;
}

export function getSshPrincipal(conn: WSConnection): SshPrincipal {
	return { userId: ws.getUserId(conn), isAdmin: ws.getRole(conn) === 'admin' };
}

/** Full connection including secrets, after checking the caller owns it. */
export function requireSshConnection(conn: WSConnection, connectionId: string): SshConnection {
	const { userId, isAdmin } = getSshPrincipal(conn);
	return sshConnectionQueries.ensureAccess(connectionId, userId, isAdmin);
}

/**
 * A forward is reachable exactly when its connection is, so resolve the forward
 * and check the owner of the host it belongs to.
 */
export function requireSshForward(conn: WSConnection, forwardId: string): SshForward {
	const forward = sshPortForwardQueries.get(forwardId);
	if (!forward) throw new Error('ssh port forward not found');
	requireSshConnection(conn, forward.connectionId);
	return forward;
}
