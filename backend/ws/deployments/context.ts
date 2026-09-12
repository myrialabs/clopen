/**
 * Which project a deployments route acts on.
 *
 * The surface lives in More Tools, and More Tools is global — a user looking at
 * project A should be able to watch project B's build without leaving their
 * session. So every route takes an OPTIONAL `projectId` and falls back to the
 * connection's current one, rather than reading the connection and nothing else.
 *
 * Access is still checked per call. `projectId` arriving from the client is a
 * request, not a permission: `requireProjectAccess` is what decides.
 *
 * Unlike the Issues surface this never resolves a worktree. A binding belongs
 * to the project, detection reads the project's own `.vercel/project.json` and
 * git remotes, and a worktree is a copy that carries both — so resolving one
 * would add a failure mode (a tree that was just deleted) and buy nothing.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import type { Project } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { requireProjectAccess } from '../access';

export interface DeployProjectContext {
	projectId: string;
	project: Project;
	/** The tree detection reads from. Always the project root. */
	root: string;
	/** True when this is the project the user is currently working in. */
	isCurrent: boolean;
}

export function resolveDeployProject(conn: WSConnection, projectId?: string): DeployProjectContext {
	const current = ws.getProjectId(conn);
	const target = (projectId ?? '').trim() || current;
	const project = requireProjectAccess(conn, target);

	return {
		projectId: target,
		project,
		root: project.path,
		isCurrent: target === current
	};
}
