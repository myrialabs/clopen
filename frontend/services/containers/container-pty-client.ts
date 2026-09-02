/**
 * Frontend PtyKit client for shells inside containers, riding Clopen's app-wide
 * WebSocket.
 *
 * A sibling of frontend/services/ssh/ssh-pty-client.ts, tunneled on
 * `containers:pty` / `containers:pty-out`. Three clients rather than one
 * because each is bound to a backend manager, and the three managers spawn
 * three different things: a local shell, a remote shell, and a shell inside a
 * container on either of those.
 */

import { PtyKitClient, hostSocket } from '@myrialabs/ptykit/client';
import ws, { onWsStatus } from '$frontend/utils/ws';

/** One PtyKit client shared by every container shell (one socket, N sessions). */
export const containerPtyClient = new PtyKitClient({
	// `url` is unused — this rides the host socket below.
	WebSocketImpl: hostSocket({
		send: (frame) => ws.emit('containers:pty', frame),
		subscribe: (onFrame) => ws.on('containers:pty-out', (frame) => onFrame(frame)),
		isOpen: () => ws.connected(),
		onStatusChange: (cb) => onWsStatus(cb)
	})
});

/**
 * The session a container's shell lives in.
 *
 * Derived from the container rather than generated, so reopening the shell —
 * after a refresh, or after a trip back to the list — reattaches to the running
 * one instead of leaving an orphan behind and starting a second.
 */
export function containerSessionId(hostId: string, containerId: string): string {
	return `container-${hostId}-${containerId.slice(0, 12)}`;
}

export function containerNamespace(hostId: string, containerId: string): string {
	return `container:${hostId}:${containerId}`;
}
