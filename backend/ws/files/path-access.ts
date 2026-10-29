import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';

import { projectQueries } from '../../database/queries/project-queries';
import { worktreeQueries } from '../../database/queries/worktree-queries';
import type { Project } from '$shared/types/database/schema';

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

/**
 * Resolve a workspace root to the project that owns it.
 *
 * A worktree root is not a registered project, so a plain project lookup
 * rejects it — which is what made the Files panel deny access to every path
 * inside a worktree.
 */
export function resolveProjectForRoot(rootPath: string): Project | null {
	const project = projectQueries.getByPath(rootPath);
	if (project) return project;

	const worktree = worktreeQueries.getByPath(rootPath);
	if (!worktree) return null;

	return projectQueries.getById(worktree.project_id);
}

export interface WorkspaceRoot {
	/** The project that owns the workspace — what access is decided on. */
	project: Project;
	/** The directory the caller asked for: the project, or one of its worktrees. */
	root: string;
	worktreeId: string | null;
}

/**
 * Resolve a workspace root and hand back the root that was requested.
 *
 * Returning the root rather than only the project is the point: callers used to
 * validate a path and then operate on `project.path`, which was identical until
 * worktrees existed and silently became "list the main tree" afterwards.
 */
export function requireWorkspaceRoot(rootPath: string): WorkspaceRoot {
	const worktree = worktreeQueries.getByPath(rootPath);
	const project = worktree
		? projectQueries.getById(worktree.project_id)
		: projectQueries.getByPath(rootPath);

	if (!project) {
		throw new Error('Access denied');
	}

	return {
		project,
		root: worktree ? worktree.path : project.path,
		worktreeId: worktree?.id ?? null
	};
}

/**
 * The canonical location of a path the owner named. Clopen controls the whole
 * machine it runs on, so there is nothing to refuse — but every file operation
 * still runs against the real path, never a symlink alias of it.
 */
export async function resolveFilePath(filePath: string): Promise<string> {
	return await resolveRealPath(filePath);
}

/**
 * Best-effort resolution of the project that contains a path, for audit
 * logging. Returns the most specific (longest-root) containing project's id,
 * or null when the path lives outside every registered project.
 */
export async function findContainingProjectId(filePath: string): Promise<string | null> {
	const normalizedPath = await resolveRealPath(filePath);
	let containing: Project | null = null;
	let containingRootLen = -1;
	for (const project of projectQueries.getAll()) {
		if (!(await isPathInside(project.path, normalizedPath))) continue;
		const projectRoot = await resolveRealPath(project.path);
		if (projectRoot.length > containingRootLen) {
			containing = project;
			containingRootLen = projectRoot.length;
		}
	}
	return containing?.id ?? null;
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
