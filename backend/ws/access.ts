import type { WSConnection } from '$shared/utils/ws-server';
import type { Project, ChatSession, DatabaseMessage } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { projectQueries, sessionQueries, messageQueries } from '$backend/database/queries';
import { resolveWorktreeRoot } from '$backend/worktrees';

/**
 * A project in the workspace list. A removed project keeps its record (so its
 * chats can be restored) but is not reachable until it is added again.
 */
export function requireProjectAccess(projectId: string): Project {
	const project = projectQueries.getById(projectId);
	if (!project || !projectQueries.isListed(projectId)) {
		throw new Error('Access denied');
	}
	return project;
}

/**
 * Project access plus the workspace root the connection is viewing.
 *
 * Anything that runs against a repository or a tree must use `root`: a worktree
 * is its own checkout, and resolving to `project.path` silently ran every git
 * command against the main tree instead.
 */
export function requireProjectWorkspace(conn: WSConnection, projectId: string): {
	project: Project;
	root: string;
	worktreeId: string | null;
} {
	const project = requireProjectAccess(projectId);
	const resolved = resolveWorktreeRoot(projectId, ws.getWorktreeId(conn));
	return { project, root: resolved.path || project.path, worktreeId: resolved.worktreeId };
}

export function requireCurrentProjectAccess(conn: WSConnection): {
	userId: string;
	projectId: string;
	project: Project;
} {
	const userId = ws.getUserId(conn);
	const projectId = ws.getProjectId(conn);
	const project = requireProjectAccess(projectId);
	return { userId, projectId, project };
}

export function requireSessionAccess(sessionId: string): ChatSession {
	const session = sessionQueries.getById(sessionId);
	if (!session) {
		throw new Error('Access denied');
	}
	requireProjectAccess(session.project_id);
	return session;
}

export function requireMessageAccess(messageId: string): DatabaseMessage {
	const message = messageQueries.getById(messageId);
	if (!message) {
		throw new Error('Access denied');
	}

	// Message access inherits session access controls.
	requireSessionAccess(message.session_id);
	return message;
}
