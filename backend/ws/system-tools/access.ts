/**
 * System Tools access guards.
 *
 * Install sessions are global (one runner per backend) but each session has
 * an owning user. Handlers must isolate sessions across users so admin A
 * cannot drive admin B's install. The router-level admin gate covers
 * authentication; this guard covers per-session ownership.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { getSession, getSessionOwner } from '$backend/engine/install-runner';

type InstallSession = NonNullable<ReturnType<typeof getSession>>;

/**
 * Throw if the install session exists but is owned by another user.
 * Returns the session if accessible, or `null` if it doesn't exist
 * (mirrors the existing handler behaviour for `install-cancel`).
 */
export function requireInstallSessionAccess(conn: WSConnection, sessionId: string): InstallSession | null {
	const userId = ws.getUserId(conn);
	const owner = getSessionOwner(sessionId);
	if (owner && owner !== userId) {
		throw new Error('Install session not found');
	}
	return getSession(sessionId);
}
