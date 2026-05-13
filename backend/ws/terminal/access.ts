/**
 * Terminal access guards.
 *
 * Resolves terminal-owned resources (PTY sessions, headless streams) to their
 * owning project, then defers to the global `requireProjectAccess` helper.
 * Centralising the lookup keeps every handler from re-implementing the
 * "manager.getSession → null check → project guard" boilerplate.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import { requireProjectAccess } from '../access';
import { ptySessionManager, type PtySession } from '../../terminal/pty-session-manager';
import { terminalStreamManager } from '../../terminal/stream-manager';

type TerminalStream = NonNullable<ReturnType<typeof terminalStreamManager.getStream>>;

export function requirePtySessionAccess(conn: WSConnection, sessionId: string): PtySession {
	const session = ptySessionManager.getSession(sessionId);
	if (!session || !session.projectId) {
		throw new Error('Access denied');
	}
	requireProjectAccess(conn, session.projectId);
	return session;
}

export function requireTerminalStreamAccess(conn: WSConnection, streamId: string): TerminalStream {
	const stream = terminalStreamManager.getStream(streamId);
	if (!stream || !stream.projectId) {
		throw new Error('Access denied');
	}
	requireProjectAccess(conn, stream.projectId);
	return stream;
}

/**
 * Resolve a (sessionId, optional streamId) pair to its owning project.
 * Used by `terminal:missed-output` which accepts either or both ids.
 * Throws if neither resolves to an accessible project.
 */
export function requireTerminalLookupAccess(
	conn: WSConnection,
	sessionId: string,
	streamId?: string
): { projectId: string; stream: TerminalStream | null; session: PtySession | null } {
	const session = ptySessionManager.getSession(sessionId) ?? null;
	const stream = streamId
		? terminalStreamManager.getStream(streamId) ?? null
		: terminalStreamManager.getStreamBySession(sessionId) ?? null;

	const projectId = session?.projectId || stream?.projectId;
	if (!projectId) {
		throw new Error('Access denied');
	}
	requireProjectAccess(conn, projectId);
	return { projectId, stream, session };
}
