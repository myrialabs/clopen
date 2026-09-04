import type { WSConnection } from '$shared/utils/ws-server';
import type { Project, ChatSession, DatabaseMessage } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { projectQueries, sessionQueries, messageQueries } from '$backend/database/queries';
import { resolveWorktreeRoot } from '$backend/worktrees';

export function requireProjectAccess(conn: WSConnection, projectId: string): Project {
	const userId = ws.getUserId(conn);
	const hasAccess = projectQueries.userHasProject(userId, projectId);
	if (!hasAccess) {
		throw new Error('Access denied');
	}

	const project = projectQueries.getById(projectId);
	if (!project) {
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
	const project = requireProjectAccess(conn, projectId);
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
	const project = requireProjectAccess(conn, projectId);
	return { userId, projectId, project };
}

export function requireSessionAccess(conn: WSConnection, sessionId: string): ChatSession {
	const session = sessionQueries.getById(sessionId);
	if (!session) {
		throw new Error('Access denied');
	}

	const userId = ws.getUserId(conn);
	const hasAccess = projectQueries.userHasProject(userId, session.project_id);
	if (!hasAccess) {
		throw new Error('Access denied');
	}

	return session;
}

export function requireMessageAccess(conn: WSConnection, messageId: string): DatabaseMessage {
	const message = messageQueries.getById(messageId);
	if (!message) {
		throw new Error('Access denied');
	}

	// Message access inherits session access controls.
	requireSessionAccess(conn, message.session_id);
	return message;
}
