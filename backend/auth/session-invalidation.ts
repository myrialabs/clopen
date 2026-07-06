/**
 * Session Invalidation
 *
 * Provides functions to invalidate user sessions when project access changes
 * or other security-relevant events occur.
 */

import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';
import { ptyKitManager } from '$backend/terminal/ptykit';

/**
 * Invalidate all active WebSocket sessions for a specific user.
 * This clears their in-memory auth state and triggers a force-logout
 * event so the frontend knows to disconnect and re-authenticate.
 *
 * Also kills any PTY terminal sessions belonging to the specified
 * project to prevent orphaned processes from continuing to run
 * after access is revoked.
 *
 * @param userId - The user whose sessions should be invalidated
 * @param projectId - Optional project ID to scope PTY cleanup
 * @returns The number of connections that were cleared
 */
export function invalidateUserSessions(userId: string, projectId?: string): number {
	const connections = ws.getConnectionsForUser(userId);
	if (connections.length === 0) {
		debug.log('auth', `No active sessions to invalidate for user ${userId}`);
		if (projectId) {
			killUserPtySessionsForProject(userId, projectId);
		}
		return 0;
	}

	const cleared = ws.clearAuthForConnections(connections);
	debug.log('auth', `Invalidated ${cleared} session(s) for user ${userId}`);

	// Notify only this user's active connections to force logout.
	ws.emit.user(userId, 'auth:force-logout-user', { reason: 'Project access revoked' });

	if (projectId) {
		killUserPtySessionsForProject(userId, projectId);
	}

	return cleared;
}

/**
 * Kill PTY terminal sessions in a project when a user's access is revoked.
 * Prevents orphaned shell processes from continuing to run. Terminals are
 * collaborative and project-scoped (PtyKit keys sessions by namespace =
 * projectId), so revoking access tears down that project's terminals.
 */
function killUserPtySessionsForProject(userId: string, projectId: string): void {
	let killedCount = 0;

	for (const session of ptyKitManager.list(projectId)) {
		debug.log('auth', `Killing PTY session ${session.sessionId} (project ${projectId} access revoked for user ${userId})`);
		ptyKitManager.killSession(session.sessionId, 'SIGKILL');
		killedCount++;
	}

	if (killedCount > 0) {
		debug.log('auth', `Killed ${killedCount} PTY session(s) in project ${projectId}`);
	}
}

/**
 * Get the number of active WebSocket connections for a user.
 * Useful for logging and debugging.
 *
 * @param userId - The user to check
 * @returns Number of active connections
 */
export function getActiveSessionCountForUser(userId: string): number {
	return ws.getConnectionsForUser(userId).length;
}
