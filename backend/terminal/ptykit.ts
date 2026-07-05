/**
 * PtyKit backend bridge.
 *
 * Clopen adopts @myrialabs/ptykit wholesale for terminal PTY sessions: the core
 * `PtyKitManager` owns spawn + scrollback + serialized reattach + backend
 * auto-detect, and an embedded `PtyKitServer` speaks the PtyKit wire protocol.
 * There is no second WebSocket — the server is driven over Clopen's existing
 * app-wide socket via `handleFrame` (see `backend/ws/terminal/tunnel.ts`).
 *
 * - `namespace` = Clopen `projectId` (collaborative room + anti-hijack scope).
 * - `authorize` bridges to Clopen's project-access check.
 */

import { PtyKitManager } from '@myrialabs/ptykit/core';
import { createPtyKitServer } from '@myrialabs/ptykit/server';
import { projectQueries } from '$backend/database/queries';

/** Terminal-friendly env, matching the previous `createCleanPtyEnv` overrides. */
const TERMINAL_ENV = {
	FORCE_COLOR: '1',
	COLORTERM: 'truecolor',
	TERM: 'xterm-256color',
	TERM_PROGRAM: 'xterm.js',
	CLICOLOR: '1',
	LC_ALL: 'en_US.UTF-8',
	LANG: 'en_US.UTF-8'
};

/** Singleton session engine — replaces pty-session-manager + stream-manager. */
export const ptyKitManager = new PtyKitManager({
	scrollback: 5000,
	// Sessions live until the tab is killed; keep exited sessions briefly so a
	// refresh/reconnect can still replay their final screen (matches old 5-min window).
	idleTtl: null,
	retainExitedMs: 5 * 60_000,
	env: { sanitize: true, inject: TERMINAL_ENV }
});

/**
 * Embedded WebSocket server over the manager. No HTTP/Bun mounting — Clopen's
 * tunnel feeds it frames and supplies per-connection `send`. `authorize` enforces
 * project access; the room is the project so output is collaborative.
 */
export const ptyKitServer = createPtyKitServer(ptyKitManager, {
	room: (ctx) => ctx.namespace,
	authorize: (ctx) => {
		const userId = ctx.conn.data.userId;
		if (typeof userId !== 'string' || !userId) return false;
		return projectQueries.userHasProject(userId, ctx.namespace);
	}
});

/**
 * Kill every PTY session belonging to a project (namespace). Used on project
 * delete/remove to reap orphaned shells. Returns the number killed.
 */
export function cleanupProjectSessions(projectId: string): number {
	let killed = 0;
	for (const session of ptyKitManager.list(projectId)) {
		ptyKitManager.killSession(session.sessionId, 'SIGKILL');
		killed++;
	}
	return killed;
}
