import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

import { projectQueries } from '../../database/queries/project-queries';
import { ws } from '$backend/utils/ws';
import type { WSConnection } from '$shared/utils/ws-server';
import type { Project } from '$shared/types/database/schema';
import { requireProjectAccess } from '../access';

/**
 * Resolve a path to its real (canonical) location, following symlinks.
 * For non-existent paths, resolves the deepest existing ancestor and
 * rejoins the unresolved tail so symlinked parent components are always
 * followed even when the leaf doesn't exist yet.
 */
async function resolveRealPath(p: string): Promise<string> {
	const abs = resolve(p);
	try {
		return await realpath(abs);
	} catch {
		const parent = dirname(abs);
		if (parent === abs) return abs;
		return join(await resolveRealPath(parent), basename(abs));
	}
}

/**
 * Check whether candidatePath is inside rootPath, resolving symlinks on both
 * sides so that a symlink inside a project root cannot escape to an external
 * target.
 */
async function isPathInside(rootPath: string, candidatePath: string): Promise<boolean> {
	const root = await resolveRealPath(rootPath);
	const candidate = await resolveRealPath(candidatePath);
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

export async function requireFilePathAccess(conn: WSConnection, filePath: string): Promise<string> {
	return await requireFilePathAccessFor(filePath, ws.getRole(conn), ws.getUserId(conn));
}

/**
 * Identity-based variant of {@link requireFilePathAccess} — usable from HTTP
 * routes (which have no `WSConnection`) once the caller has resolved the user
 * from a bearer token. Same access policy as the WS version.
 */
export async function requireFilePathAccessFor(filePath: string, role: string | null, userId: string | null): Promise<string> {
	const normalizedPath = await resolveRealPath(filePath);
	if (role === 'admin') {
		return normalizedPath;
	}
	if (!userId) {
		throw new Error('Access denied');
	}

	const projects = projectQueries.getAllForUser(userId);
	for (const project of projects) {
		if (await isPathInside(project.path, normalizedPath)) {
			return normalizedPath;
		}
	}

	throw new Error('Access denied');
}

// Picker-style guard: allow paths inside the user's accessible projects OR
// outside every registered project. Rejects only when the path lives inside
// another project the user cannot access. Used by FolderBrowser flows that
// operate around / before a project exists.
export async function requireSharedFilePathAccess(conn: WSConnection, filePath: string): Promise<string> {
	const normalizedPath = await resolveRealPath(filePath);
	if (ws.getRole(conn) === 'admin') {
		return normalizedPath;
	}
	const userId = ws.getUserId(conn);
	const allProjects = projectQueries.getAll();

	// Ancestor guard: reject if the path is a parent of another user's project.
	// Without this, renaming/deleting `/foo` would break a project rooted at
	// `/foo/bar` even though `/foo` itself is not "inside" any project.
	for (const project of allProjects) {
		const projectRoot = await resolveRealPath(project.path);
		if (projectRoot === normalizedPath) continue; // equality is handled below
		if (!(await isPathInside(normalizedPath, project.path))) continue;
		if (!projectQueries.userHasProject(userId, project.id)) {
			throw new Error('Access denied');
		}
	}

	// Pick the most specific (longest matching root) project so nested project
	// roots resolve to the inner one, not whichever the DB returns first.
	let containing: { id: string; path: string } | null = null;
	for (const project of allProjects) {
		if (!(await isPathInside(project.path, normalizedPath))) continue;
		const projectRoot = await resolveRealPath(project.path);
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

export async function filterAccessibleExpandedPaths(rootPath: string, expandedPaths?: Set<string>): Promise<Set<string> | undefined> {
	if (!expandedPaths) return undefined;
	const filtered = new Set<string>();

	for (const expandedPath of expandedPaths) {
		if (await isPathInside(rootPath, expandedPath)) {
			filtered.add(await resolveRealPath(expandedPath));
		}
	}

	return filtered;
}
