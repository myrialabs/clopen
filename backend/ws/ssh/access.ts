import { sshConnectionQueries } from '../../database/queries';
import { sshPortForwardQueries } from '../../database/queries';
import type { SshConnection, SshForward } from '$shared/types/ssh';

/** Full connection including secrets, or an error when it does not exist. */
export function requireSshConnection(connectionId: string): SshConnection {
	return sshConnectionQueries.require(connectionId);
}

/** A forward, after checking the host it belongs to still exists. */
export function requireSshForward(forwardId: string): SshForward {
	const forward = sshPortForwardQueries.get(forwardId);
	if (!forward) throw new Error('ssh port forward not found');
	requireSshConnection(forward.connectionId);
	return forward;
}
