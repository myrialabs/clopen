/**
 * ssh-client WebSocket router.
 *
 * Terminal sessions run on their own PtyKit manager and are tunneled over this
 * socket (tunnel.ts); everything else is ordinary request/response.
 */

import { createRouter } from '$shared/utils/ws-server';
import { sshConnectionsHandler } from './connections';
import { sshSftpHandler } from './sftp';
import { sshForwardsHandler } from './forwards';
import { sshTunnelHandler } from './tunnel';

export const sshRouter = createRouter()
	.merge(sshConnectionsHandler)
	.merge(sshSftpHandler)
	.merge(sshForwardsHandler)
	.merge(sshTunnelHandler);
