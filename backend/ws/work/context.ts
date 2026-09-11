/**
 * Which project an issues route acts on.
 *
 * The surface lives in More Tools, and More Tools is global — a user looking at
 * project A should be able to read project B's issues without leaving their
 * session. So every route takes an OPTIONAL `projectId` and falls back to the
 * connection's current one, rather than reading the connection and nothing else.
 *
 * Access is still checked per call. `projectId` arriving from the client is a
 * request, not a permission: `requireProjectAccess` is what decides.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import type { Project } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { resolveWorktreeRoot } from '$backend/worktrees';
import { requireProjectAccess } from '../access';

export interface IssueProjectContext {
	projectId: string;
	project: Project;
	/**
	 * The tree git commands run against.
	 *
	 * Worktree-aware ONLY for the project the connection is actually viewing: a
	 * worktree belongs to a session, and resolving another project's root
	 * through this connection's worktree id would run git in the wrong tree —
	 * or in one that does not exist.
	 */
	root: string;
	/** True when this is the project the user is currently working in. */
	isCurrent: boolean;
}

export function resolveWorkProject(conn: WSConnection, projectId?: string): IssueProjectContext {
	const current = ws.getProjectId(conn);
	const target = (projectId ?? '').trim() || current;
	const project = requireProjectAccess(conn, target);

	if (target !== current) {
		return { projectId: target, project, root: project.path, isCurrent: false };
	}

	const resolved = resolveWorktreeRoot(target, ws.getWorktreeId(conn));
	return {
		projectId: target,
		project,
		root: resolved.path || project.path,
		isCurrent: true
	};
}
