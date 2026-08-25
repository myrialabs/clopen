/**
 * ssh-client — the SSH terminal tunnel.
 *
 * Mirrors backend/ws/terminal/tunnel.ts: PtyKit's wire protocol rides Clopen's
 * app-wide socket on `ssh:pty` / `ssh:pty-out`, with one embedded PtyKit
 * connection per Clopen connection.
 *
 * One thing this tunnel does that the local one does not: it stamps the spawn
 * target onto every `create-session` frame. The client says which host it wants
 * through the namespace, which `authorize` checks ownership of; the connection
 * id the backend actually dials is then derived from that namespace here, so a
 * client cannot name one host in the namespace and open a shell on another.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import type { PtyKitConnection } from '@myrialabs/ptykit/server';
import type { WireFrame } from '@myrialabs/ptykit';
import { ws } from '$backend/utils/ws';
import { encodeSshTarget } from '../../ssh/pty-backend';
import { connectionIdFromNamespace, sshPtyKitServer } from '../../ssh/ptykit';
import { debug } from '$shared/utils/logger';

/** One embedded PtyKit connection per Clopen ws connection (by stable id). */
const sshPtyConnections = new Map<string, PtyKitConnection>();

function getSshPtyConnection(conn: WSConnection): PtyKitConnection {
	const connId = ws.getConnectionId(conn);
	if (!connId) {
		throw new Error('Connection not registered');
	}

	const existing = sshPtyConnections.get(connId);
	if (existing) return existing;

	const userId = ws.getUserId(conn);
	const isAdmin = ws.getRole(conn) === 'admin';
	const ptyConn = sshPtyKitServer.createConnection({
		data: { userId, isAdmin, connId },
		send: (frame) => {
			ws.sendToConnectionId(connId, JSON.stringify({ action: 'ssh:pty-out', payload: frame }));
		}
	});
	sshPtyKitServer.handleOpen(ptyConn);
	sshPtyConnections.set(connId, ptyConn);

	ws.addCleanup(conn, () => {
		sshPtyKitServer.handleClose(ptyConn);
		sshPtyConnections.delete(connId);
	});

	debug.log('ssh', `PtyKit connection opened for ${connId}`);
	return ptyConn;
}

/**
 * Replace whatever `shell` the client sent with the target derived from the
 * frame's own namespace. Frames that are not `create-session` pass through.
 */
function stampSpawnTarget(frame: WireFrame): WireFrame {
	if (frame.action !== 'create-session') return frame;

	const payload = frame.payload as { requestId?: string; data?: Record<string, unknown> } | null;
	const request = payload?.data;
	if (!request || typeof request.namespace !== 'string') return frame;

	const connectionId = connectionIdFromNamespace(request.namespace);
	if (!connectionId) return frame;

	return {
		action: frame.action,
		payload: { ...payload, data: { ...request, shell: encodeSshTarget(connectionId) } }
	};
}

export const sshTunnelHandler = createRouter()
	// Client → server: one PtyKit wire frame for a remote shell.
	.on('ssh:pty', {
		data: t.Object({
			action: t.String(),
			payload: t.Any()
		})
	}, ({ conn, data }) => {
		const ptyConn = getSshPtyConnection(conn);
		void sshPtyKitServer.handleFrame(ptyConn, stampSpawnTarget(data as WireFrame));
	})
	// Server → client: PtyKit wire frames. Declared for the typed WSAPI; actually
	// sent via ws.sendToConnectionId above.
	.emit('ssh:pty-out', t.Object({
		action: t.String(),
		payload: t.Any()
	}));
