/**
 * Worktrees: full copies of a project under `worktrees/<project id>/<slug>`.
 *
 * Folders with no worktree row are leftovers (a removal interrupted half-way, or
 * a project folder emptied of worktrees) and nothing can open them again. A
 * worktree that has a row is the user's work and is only ever removed through
 * `removeWorktree`, and only when nothing in it differs from the main tree —
 * a worktree with changes not yet applied is never a cleanup candidate,
 * whatever its age.
 */

import fs from 'node:fs/promises';
import { join } from 'node:path';
import { projectQueries, worktreeQueries } from '$backend/database/queries';
import { getWorktreesRootDir, pendingChangeCountOrNull, removeWorktree } from '$backend/worktrees';
import type { Worktree } from '$shared/types/database/schema';
import { measurePath, removePath } from './fs-size';

const DAY_MS = 24 * 60 * 60_000;

export interface WorktreeDir {
	path: string;
	bytes: number;
	worktree: Worktree | null;
	projectId: string | null;
}

export async function listWorktreeDirs(signal?: AbortSignal): Promise<WorktreeDir[]> {
	const root = getWorktreesRootDir();
	const byPath = new Map<string, Worktree>();
	for (const project of projectQueries.getAll()) {
		for (const worktree of worktreeQueries.getByProjectId(project.id)) byPath.set(worktree.path, worktree);
	}

	const dirs: WorktreeDir[] = [];
	let projectDirs: import('node:fs').Dirent[];
	try {
		projectDirs = await fs.readdir(root, { withFileTypes: true });
	} catch {
		return dirs;
	}
	for (const projectDir of projectDirs) {
		if (signal?.aborted) break;
		if (!projectDir.isDirectory()) continue;
		const projectPath = join(root, projectDir.name);
		const children = await fs.readdir(projectPath, { withFileTypes: true }).catch(() => []);
		if (children.length === 0) {
			dirs.push({ path: projectPath, bytes: (await measurePath(projectPath)).bytes, worktree: null, projectId: null });
			continue;
		}
		for (const child of children) {
			if (!child.isDirectory()) continue;
			const path = join(projectPath, child.name);
			const worktree = byPath.get(path) ?? null;
			dirs.push({
				path,
				bytes: (await measurePath(path, signal)).bytes,
				worktree,
				projectId: worktree?.project_id ?? null
			});
		}
	}
	return dirs;
}

export function orphanWorktreeDirs(dirs: WorktreeDir[]): WorktreeDir[] {
	return dirs.filter(dir => !dir.worktree);
}

export async function removeWorktreeDirs(dirs: WorktreeDir[]): Promise<{ freedBytes: number; removed: number }> {
	let freedBytes = 0;
	let removed = 0;
	for (const dir of dirs) {
		if (dir.worktree) continue;
		freedBytes += await removePath(dir.path);
		removed++;
	}
	return { freedBytes, removed };
}

/**
 * Worktrees unopened for `olderThanDays` with nothing left to apply, and no chat
 * of theirs running.
 */
export async function staleWorktrees(
	dirs: WorktreeDir[],
	options: { olderThanDays: number; projectId?: string | null; activeChatWorktrees: Set<string> }
): Promise<WorktreeDir[]> {
	const cutoff = Date.now() - options.olderThanDays * DAY_MS;
	const stale: WorktreeDir[] = [];
	for (const dir of dirs) {
		const worktree = dir.worktree;
		if (!worktree) continue;
		if (options.projectId && worktree.project_id !== options.projectId) continue;
		if (options.activeChatWorktrees.has(worktree.id)) continue;
		const lastUsed = Date.parse(worktree.last_opened_at ?? worktree.created_at);
		if (!Number.isFinite(lastUsed) || lastUsed >= cutoff) continue;
		if (await pendingChangeCountOrNull(worktree.id) !== 0) continue;
		stale.push(dir);
	}
	return stale;
}

export async function removeWorktrees(dirs: WorktreeDir[]): Promise<{ freedBytes: number; removed: number }> {
	let freedBytes = 0;
	let removed = 0;
	for (const dir of dirs) {
		if (!dir.worktree) continue;
		await removeWorktree(dir.worktree.id);
		freedBytes += dir.bytes;
		removed++;
	}
	return { freedBytes, removed };
}
