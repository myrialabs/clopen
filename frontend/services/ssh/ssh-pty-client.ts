/**
 * Frontend PtyKit client for remote shells, riding Clopen's app-wide WebSocket.
 *
 * A sibling of frontend/services/terminal/ptykit-client.ts, tunneled on
 * `ssh:pty` / `ssh:pty-out` instead of `terminal:pty`. Two clients rather than
 * one because each is bound to a backend manager, and the SSH manager spawns
 * remote shells while the terminal manager spawns local ones.
 */

import { PtyKitClient, hostSocket } from '@myrialabs/ptykit/client';
import ws, { onWsStatus } from '$frontend/utils/ws';

/** One PtyKit client shared by every SSH tab (one socket, N sessions). */
export const sshPtyClient = new PtyKitClient({
	// `url` is unused — this rides the host socket below.
	WebSocketImpl: hostSocket({
		send: (frame) => ws.emit('ssh:pty', frame),
		subscribe: (onFrame) => ws.on('ssh:pty-out', (frame) => onFrame(frame)),
		isOpen: () => ws.connected(),
		onStatusChange: (cb) => onWsStatus(cb)
	})
});

/**
 * Minimal structural view of a PtyKit session — what the tab bar acts on. Kept
 * structural (not the `ClientSession` class) so nothing here ties to PtyKit's
 * dist-vs-source class identity when `<PtyTerminal>` hands its session back.
 */
export interface SshSessionHandle {
	write(data: string): void;
	resize(cols: number, rows: number): Promise<void>;
	cancel(): Promise<void>;
	clear(): Promise<void>;
	kill(): Promise<void>;
	detach(): void;
}

const sessionHandles = new Map<string, SshSessionHandle>();

export function registerSshSession(sessionId: string, session: SshSessionHandle): void {
	sessionHandles.set(sessionId, session);
}

export function unregisterSshSession(sessionId: string): void {
	sessionHandles.delete(sessionId);
}

export function getSshSession(sessionId: string): SshSessionHandle | undefined {
	return sessionHandles.get(sessionId);
}
