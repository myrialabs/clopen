/**
 * Which project a db-client route acts on.
 *
 * DB Client is a global surface: the connection list is not scoped to a
 * project, and most routes need no project at all. But three things the
 * Supabase tabs do are facts about a WORKING TREE rather than about a database
 * — where the migration files are, where edge functions live, and where
 * generated types get written — so those routes take an optional `projectId`
 * and fall back to the connection's current one, exactly as the Deployments
 * surface does.
 *
 * `projectId` arriving from the client is a request, not a permission:
 * `requireProjectAccess` is what decides, and a route that resolves no project
 * degrades to "no local files" rather than reaching for one it was not given.
 */

import type { WSConnection } from '$shared/utils/ws-server';
import type { Project } from '$shared/types/database/schema';
import { ws } from '$backend/utils/ws';
import { requireProjectAccess } from '../access';

export interface DbClientProjectContext {
	projectId: string;
	project: Project;
	root: string;
}

export function resolveDbClientProject(
	conn: WSConnection,
	projectId?: string
): DbClientProjectContext | null {
	const target = (projectId ?? '').trim() || ws.getProjectId(conn);
	if (!target) return null;

	const project = requireProjectAccess(conn, target);
	return { projectId: target, project, root: project.path };
}
