import type { WSConnection } from '$shared/utils/ws-server';
import type { Project, ChatSession, DatabaseMessage } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { projectQueries, sessionQueries, messageQueries } from '$backend/database/queries';

export function requireProjectAccess(conn: WSConnection, projectId: string): Project {
	const userId = ws.getUserId(conn);
	const hasAccess = projectQueries.userHasProject(userId, projectId);
	if (!hasAccess) {
		throw new Error('Project not found');
	}

	const project = projectQueries.getById(projectId);
	if (!project) {
		throw new Error('Project not found');
	}

	return project;
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
		throw new Error('Session not found');
	}

	const userId = ws.getUserId(conn);
	const hasAccess = projectQueries.userHasProject(userId, session.project_id);
	if (!hasAccess) {
		throw new Error('Session not found');
	}

	return session;
}

export function requireMessageAccess(conn: WSConnection, messageId: string): DatabaseMessage {
	const message = messageQueries.getById(messageId);
	if (!message) {
		throw new Error('Message not found');
	}

	// Message access inherits session access controls.
	requireSessionAccess(conn, message.session_id);
	return message;
}
