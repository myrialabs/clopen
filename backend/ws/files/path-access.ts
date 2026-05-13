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
		throw new Error('Access denied');
	}
	if (ws.getRole(conn) === 'admin') {
		return project;
	}
	return requireProjectAccess(conn, project.id);
}

export function requireFilePathAccess(conn: WSConnection, filePath: string): string {
	const normalizedPath = resolve(filePath);
	if (ws.getRole(conn) === 'admin') {
		return normalizedPath;
	}

	const userId = ws.getUserId(conn);
	const projects = projectQueries.getAllForUser(userId);

	const hasAccess = projects.some((project) => isPathInside(project.path, normalizedPath));
	if (!hasAccess) {
		throw new Error('Access denied');
	}

	return normalizedPath;
}

// Picker-style guard: allow paths inside the user's accessible projects OR
// outside every registered project. Rejects only when the path lives inside
// another project the user cannot access. Used by FolderBrowser flows that
// operate around / before a project exists.
export function requireSharedFilePathAccess(conn: WSConnection, filePath: string): string {
	const normalizedPath = resolve(filePath);
	if (ws.getRole(conn) === 'admin') {
		return normalizedPath;
	}
	const userId = ws.getUserId(conn);
	const allProjects = projectQueries.getAll();

	// Ancestor guard: reject if the path is a parent of another user's project.
	// Without this, renaming/deleting `/foo` would break a project rooted at
	// `/foo/bar` even though `/foo` itself is not "inside" any project.
	for (const project of allProjects) {
		const projectRoot = resolve(project.path);
		if (projectRoot === normalizedPath) continue; // equality is handled below
		if (!isPathInside(normalizedPath, project.path)) continue;
		if (!projectQueries.userHasProject(userId, project.id)) {
			throw new Error('Access denied');
		}
	}

	// Pick the most specific (longest matching root) project so nested project
	// roots resolve to the inner one, not whichever the DB returns first.
	let containing: { id: string; path: string } | null = null;
	for (const project of allProjects) {
		if (!isPathInside(project.path, normalizedPath)) continue;
		const projectRoot = resolve(project.path);
		if (!containing || projectRoot.length > resolve(containing.path).length) {
			containing = project;
		}
	}

	if (!containing) {
		return normalizedPath;
	}

	const hasAccess = projectQueries.userHasProject(userId, containing.id);
	if (!hasAccess) {
		throw new Error('Access denied');
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
