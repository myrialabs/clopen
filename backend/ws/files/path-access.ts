import { isAbsolute, relative, resolve } from 'node:path';

import { projectQueries } from '../../database/queries/project-queries';
import { ws } from '$backend/utils/ws';
import type { WSConnection } from '$shared/utils/ws-server';
import type { Project } from '$shared/types/database/schema';
import { requireProjectAccess } from '../access';

function isPathInside(rootPath: string, candidatePath: string): boolean {
	const root = resolve(rootPath);
	const candidate = resolve(candidatePath);
	const rel = relative(root, candidate);
	return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function requireProjectPathAccess(conn: WSConnection, projectPath: string): Project {
	const project = projectQueries.getByPath(projectPath);
	if (!project) {
		throw new Error('Project not found');
	}
	return requireProjectAccess(conn, project.id);
}

export function requireFilePathAccess(conn: WSConnection, filePath: string): string {
	const normalizedPath = resolve(filePath);
	const userId = ws.getUserId(conn);
	const projects = projectQueries.getAllForUser(userId);

	const hasAccess = projects.some((project) => isPathInside(project.path, normalizedPath));
	if (!hasAccess) {
		throw new Error('File path is outside accessible projects');
	}

	return normalizedPath;
}

export function filterAccessibleExpandedPaths(rootPath: string, expandedPaths?: Set<string>): Set<string> | undefined {
	if (!expandedPaths) return undefined;
	const filtered = new Set<string>();

	for (const expandedPath of expandedPaths) {
		if (isPathInside(rootPath, expandedPath)) {
			filtered.add(resolve(expandedPath));
		}
	}

	return filtered;
}
