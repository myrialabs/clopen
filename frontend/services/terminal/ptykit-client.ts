/**
 * Frontend PtyKit client, riding Clopen's app-wide WebSocket.
 *
 * Instead of opening a second socket to a `/pty` endpoint, PtyKit's browser
 * client is adapted onto the existing `ws` connection with `hostSocket`: PtyKit
 * frames are tunneled as `terminal:pty` (out) / `terminal:pty-out` (in) and
 * PtyKit keeps its reconnect / heal / reattach on top. The backend embedded
 * server (backend/ws/terminal/tunnel.ts) is the other end.
 */

import { PtyKitClient, hostSocket } from '@myrialabs/ptykit/client';
import ws, { onWsStatus } from '$frontend/utils/ws';

/** A single PtyKit client shared by every terminal tab (one socket, N sessions). */
export const ptyClient = new PtyKitClient({
	// `url` is unused — we ride the host socket below.
	WebSocketImpl: hostSocket({
		send: (frame) => ws.emit('terminal:pty', frame),
		subscribe: (onFrame) => ws.on('terminal:pty-out', (frame) => onFrame(frame)),
		isOpen: () => ws.connected(),
		onStatusChange: (cb) => onWsStatus(cb)
	})
});

/**
 * Minimal structural view of a PtyKit session — just what the tab bar / project
 * cleanup act on. Kept structural (not the `ClientSession` class) so nothing here
 * ties to PtyKit's dist-vs-source class identity when a `<PtyTerminal>` (shipped
 * as source) hands its session back via `onready`.
 */
export interface TerminalSessionHandle {
	write(data: string): void;
	resize(cols: number, rows: number): Promise<void>;
	cancel(): Promise<void>;
	clear(): Promise<void>;
	kill(): Promise<void>;
	detach(): void;
}

/**
 * Live session handles keyed by sessionId, populated by each mounted
 * `<PtyTerminal>` (via its `onready`). Lets non-render code — close/clear/cancel
 * from the tab bar, project cleanup — act on a tab's session directly.
 */
const sessionHandles = new Map<string, TerminalSessionHandle>();

export function registerSession(sessionId: string, session: TerminalSessionHandle): void {
	sessionHandles.set(sessionId, session);
}

export function unregisterSession(sessionId: string): void {
	sessionHandles.delete(sessionId);
}

export function getSession(sessionId: string): TerminalSessionHandle | undefined {
	return sessionHandles.get(sessionId);
}
