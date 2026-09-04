/**
 * Resolving the working root of a chat session.
 *
 * Anything that runs on behalf of a session — the engine, snapshots, file
 * reads — must use this rather than the path the client sent. The client's
 * value is a view preference; the session's worktree is the fact, and letting
 * the two disagree is how an isolated task ends up writing into the main tree.
 */

import { existsSync } from 'fs';
import { projectQueries, sessionQueries, worktreeQueries } from '../database/queries';
import { debug } from '$shared/utils/logger';

export interface SessionRoot {
	path: string;
	projectId: string;
	worktreeId: string | null;
	worktreeName: string | null;
}

/**
 * Root directory a worktree points at, or the project path when `worktreeId` is
 * null. Falls back to the project when the worktree directory has vanished —
 * a session must stay usable even if its worktree was deleted outside Clopen.
 */
export function resolveWorktreeRoot(projectId: string, worktreeId: string | null): SessionRoot {
	const project = projectQueries.getById(projectId);
	const projectPath = project?.path ?? '';

	if (!worktreeId) {
		return { path: projectPath, projectId, worktreeId: null, worktreeName: null };
	}

	const worktree = worktreeQueries.getById(worktreeId);
	if (!worktree || worktree.project_id !== projectId) {
		return { path: projectPath, projectId, worktreeId: null, worktreeName: null };
	}

	if (!existsSync(worktree.path)) {
		debug.warn('worktree', `Worktree directory missing, using main tree: ${worktree.path}`);
		return { path: projectPath, projectId, worktreeId: null, worktreeName: null };
	}

	return {
		path: worktree.path,
		projectId,
		worktreeId: worktree.id,
		worktreeName: worktree.name
	};
}

/** Working root for a session, or null when the session is unknown. */
export function resolveSessionRoot(sessionId: string): SessionRoot | null {
	const session = sessionQueries.getById(sessionId);
	if (!session) return null;
	return resolveWorktreeRoot(session.project_id, session.worktree_id ?? null);
}

/**
 * Working root for a session, preferring the session's own binding and falling
 * back to the caller-supplied path when the session cannot be resolved.
 */
export function resolveSessionPath(sessionId: string | undefined, fallbackPath: string): string {
	if (!sessionId) return fallbackPath;
	const root = resolveSessionRoot(sessionId);
	return root?.path || fallbackPath;
}
