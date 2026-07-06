/**
 * Terminal tunnel — carries the PtyKit wire protocol over Clopen's app-wide
 * WebSocket instead of a dedicated `/pty` socket.
 *
 * Inbound client frames arrive on `terminal:pty`; each Clopen connection gets one
 * embedded `PtyKitConnection` whose `send` unicasts frames back on
 * `terminal:pty-out` (RPC responses + reattach replay) while PtyKit's own room
 * registry fans collaborative output out to every viewer. Identity (`userId`) is
 * carried on the connection so `authorize` can enforce project access.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSConnection } from '$shared/utils/ws-server';
import type { PtyKitConnection } from '@myrialabs/ptykit/server';
import type { WireFrame } from '@myrialabs/ptykit';
import { ws } from '$backend/utils/ws';
import { ptyKitServer } from '../../terminal/ptykit';
import { debug } from '$shared/utils/logger';

/** One embedded PtyKit connection per Clopen ws connection (by stable id). */
const ptyConnections = new Map<string, PtyKitConnection>();

/** Resolve (or lazily create) the PtyKit connection backing a Clopen connection. */
function getPtyConnection(conn: WSConnection): PtyKitConnection {
	const connId = ws.getConnectionId(conn);
	if (!connId) {
		throw new Error('Connection not registered');
	}

	const existing = ptyConnections.get(connId);
	if (existing) return existing;

	const userId = ws.getUserId(conn);
	const ptyConn = ptyKitServer.createConnection({
		data: { userId, connId },
		send: (frame) => {
			ws.sendToConnectionId(connId, JSON.stringify({ action: 'terminal:pty-out', payload: frame }));
		}
	});
	ptyKitServer.handleOpen(ptyConn);
	ptyConnections.set(connId, ptyConn);

	// Tear the PtyKit connection down (leave rooms) when the socket closes.
	ws.addCleanup(conn, () => {
		ptyKitServer.handleClose(ptyConn);
		ptyConnections.delete(connId);
	});

	debug.log('terminal', `🔌 PtyKit connection opened for ${connId}`);
	return ptyConn;
}

export const terminalTunnelHandler = createRouter()
	// Client → server: one PtyKit wire frame.
	.on('terminal:pty', {
		data: t.Object({
			action: t.String(),
			payload: t.Any()
		})
	}, ({ conn, data }) => {
		const ptyConn = getPtyConnection(conn);
		void ptyKitServer.handleFrame(ptyConn, data as WireFrame);
	})
	// Server → client: PtyKit wire frames (RPC responses + broadcast events,
	// including PtyKit's own room-level `tab-created` / `tab-closed`). Declared for
	// the typed WSAPI; actually sent via ws.sendToConnectionId above.
	//
	// Collaborative tab-list sync rides this same stream: the frontend subscribes
	// to PtyKit's tab events via `ptyClient.onSessionCreated` / `onSessionClosed`
	// (see frontend/services/terminal/project.service.ts), so there are no
	// Clopen-native tab events to declare here.
	.emit('terminal:pty-out', t.Object({
		action: t.String(),
		payload: t.Any()
	}));
