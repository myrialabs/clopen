/**
 * Worktree location and naming.
 *
 * Worktrees live outside the project directory. Inside it they would be picked
 * up as nested repos by the Git panel, walked by the file watcher, and shown to
 * the agent as part of its own tree.
 */

import path from 'path';
import { getClopenDir } from '../utils/paths';

/** Root that holds every worktree of every project. */
export function getWorktreesRootDir(): string {
	return path.join(getClopenDir(), 'worktrees');
}

/** Directory that holds one project's worktrees. */
export function getProjectWorktreesDir(projectId: string): string {
	return path.join(getWorktreesRootDir(), projectId);
}

/** Absolute path of a single worktree. */
export function getWorktreePath(projectId: string, slug: string): string {
	return path.join(getProjectWorktreesDir(projectId), slug);
}

/**
 * Turn a display name into a directory-safe slug.
 * Returns an empty string when nothing usable survives — callers substitute one.
 */
export function slugifyWorktreeName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

/**
 * Pick a slug not already used by this project.
 * `taken` is the set of existing slugs; a numeric suffix is added on collision.
 */
export function uniqueWorktreeSlug(name: string, taken: Set<string>): string {
	const base = slugifyWorktreeName(name) || 'worktree';
	if (!taken.has(base)) return base;

	for (let suffix = 2; suffix < 1000; suffix++) {
		const candidate = `${base}-${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}

	return `${base}-${Date.now()}`;
}

/** Whether `candidate` sits inside `root` (or is `root` itself). */
export function isPathInside(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
