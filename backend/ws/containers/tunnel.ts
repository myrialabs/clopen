/**
 * Containers — the shell tunnel.
 *
 * Mirrors backend/ws/ssh/tunnel.ts: PtyKit's wire protocol rides Clopen's
 * app-wide socket on `containers:pty` / `containers:pty-out`, with one embedded
 * PtyKit connection per Clopen connection.
 *
 * As with the SSH tunnel, the spawn target is stamped here rather than taken
 * from the client. The namespace is the only thing the client says about what
 * it wants, `authorize` has already checked that it may have it, and the target
 * is derived from that same namespace — so naming one container in the
 * namespace and another in the payload cannot open a shell anywhere.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import type { PtyKitConnection } from '@myrialabs/ptykit/server';
import type { WireFrame } from '@myrialabs/ptykit';
import { ws } from '$backend/utils/ws';
import { encodeContainerTarget } from '../../containers/pty-backend';
import { containerPtyKitServer, rememberNamespace, targetFromNamespace } from '../../containers/pty';
import { debug } from '$shared/utils/logger';

/** One embedded PtyKit connection per Clopen ws connection (by stable id). */
const containerPtyConnections = new Map<string, PtyKitConnection>();

function getContainerPtyConnection(conn: WSConnection): PtyKitConnection {
	const connId = ws.getConnectionId(conn);
	if (!connId) {
		throw new Error('Connection not registered');
	}

	const existing = containerPtyConnections.get(connId);
	if (existing) return existing;

	const userId = ws.getUserId(conn);
	const isAdmin = ws.getRole(conn) === 'admin';
	const ptyConn = containerPtyKitServer.createConnection({
		data: { userId, isAdmin, connId },
		send: (frame) => {
			ws.sendToConnectionId(connId, JSON.stringify({ action: 'containers:pty-out', payload: frame }));
		}
	});
	containerPtyKitServer.handleOpen(ptyConn);
	containerPtyConnections.set(connId, ptyConn);

	ws.addCleanup(conn, () => {
		containerPtyKitServer.handleClose(ptyConn);
		containerPtyConnections.delete(connId);
	});

	debug.log('containers', `PtyKit connection opened for ${connId}`);
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

	const target = targetFromNamespace(request.namespace);
	if (!target) return frame;
	rememberNamespace(request.namespace);

	return {
		action: frame.action,
		payload: { ...payload, data: { ...request, shell: encodeContainerTarget(target) } }
	};
}

export const containersTunnelHandler = createRouter()
	// Client → server: one PtyKit wire frame for a container shell.
	.on(
		'containers:pty',
		{
			data: t.Object({
				action: t.String(),
				payload: t.Any()
			})
		},
		({ conn, data }) => {
			const ptyConn = getContainerPtyConnection(conn);
			void containerPtyKitServer.handleFrame(ptyConn, stampSpawnTarget(data as WireFrame));
		}
	)
	// Server → client: PtyKit wire frames. Declared for the typed WSAPI; actually
	// sent via ws.sendToConnectionId above.
	.emit(
		'containers:pty-out',
		t.Object({
			action: t.String(),
			payload: t.Any()
		})
	);
