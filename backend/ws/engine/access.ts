/**
 * Engine access guards.
 *
 * Engine accounts (Claude, Codex, Copilot, Qwen, OpenCode) are global system
 * credentials. Mutations are gated to admins at the router level via
 * `ADMIN_ONLY_ROUTES`. This file covers the leftover concern: setup-flow
 * PTY sessions belong to the admin who started them, so other admins cannot
 * submit codes or cancel into someone else's flow.
 *
 * Each engine keeps its own `Map<setupId, SetupProcess>` (Claude, Codex, …).
 * The shape varies, but every entry tracks `userId` + a `disposed` flag, so
 * we type the helper against that minimal contract.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';

export interface SetupProcessLike {
	userId: string;
	disposed: boolean;
}

/**
 * Resolve a setup-flow session and verify the caller owns it. Throws with the
 * same generic error for "missing", "expired", and "owned by another user" so
 * we don't leak existence of another admin's setup.
 */
export function requireSetupSessionAccess<T extends SetupProcessLike>(
	conn: WSConnection,
	setupId: string,
	setupProcesses: Map<string, T>
): T {
	const userId = ws.getUserId(conn);
	const entry = setupProcesses.get(setupId);
	if (!entry || entry.disposed || entry.userId !== userId) {
		throw new Error('Setup session not found or expired');
	}
	return entry;
}
