/**
 * Materialising a worktree from the main tree.
 *
 * Preferred path is a copy-on-write clone (`COPYFILE_FICLONE`): on APFS, btrfs
 * and reflink-capable XFS this is near-instant and costs no extra disk until a
 * file is written, so the worktree can carry everything the project needs to
 * actually run — `.git`, `node_modules`, `.env` — not just tracked files.
 *
 * Where reflink is unavailable (different volume, ext4 without reflink, NTFS)
 * a real byte copy of that much data would be unacceptable, so the clone falls
 * back to gitignore-eligible files plus `.git` and the caller is told to run a
 * setup command for dependencies.
 */

import fs from 'fs/promises';
import { constants as fsConstants, type Dirent } from 'fs';
import path from 'path';
import type { WorktreeCloneMode } from '$shared/types/database/schema';
import { debug } from '$shared/utils/logger';
import { getSnapshotFiles } from '../snapshot/gitignore';

/** Above this many entries a full-tree walk is refused and the lean clone is used. */
const MAX_FULL_CLONE_ENTRIES = 200_000;

/** Never copied — process-local state that must not be shared between trees. */
const NEVER_CLONE = new Set(['.DS_Store', '.clopen-reflink-probe']);

export interface CloneResult {
	mode: WorktreeCloneMode;
	fileCount: number;
	/** True when ignored files (dependencies, .env) were carried over. */
	carriedIgnoredFiles: boolean;
}

/**
 * Probe whether `targetDir` can hold reflinks of files from `sourceDir`.
 * Uses a real file from the project so the answer accounts for both filesystems.
 */
export async function probeReflinkSupport(sourceDir: string, targetDir: string): Promise<boolean> {
	const probeSource = await findProbeFile(sourceDir);
	if (!probeSource) return false;

	const probeTarget = path.join(targetDir, '.clopen-reflink-probe');
	try {
		await fs.copyFile(probeSource, probeTarget, fsConstants.COPYFILE_FICLONE_FORCE);
		return true;
	} catch {
		return false;
	} finally {
		await fs.rm(probeTarget, { force: true }).catch(() => {});
	}
}

/** Find a small regular file to probe with; returns null for an empty project. */
async function findProbeFile(dirPath: string): Promise<string | null> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dirPath, { withFileTypes: true });
	} catch {
		return null;
	}

	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const full = path.join(dirPath, entry.name);
		try {
			const stat = await fs.stat(full);
			if (stat.size > 0 && stat.size < 1024 * 1024) return full;
		} catch {
			// Unreadable — try the next one
		}
	}

	// No usable file at the top level; one level down is enough to decide.
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === '.git') continue;
		const nested = await findProbeFile(path.join(dirPath, entry.name));
		if (nested) return nested;
	}

	return null;
}

/**
 * Clone `sourceRoot` into `targetRoot`.
 * `targetRoot` must already exist and be empty.
 */
export async function cloneTree(sourceRoot: string, targetRoot: string): Promise<CloneResult> {
	const canReflink = await probeReflinkSupport(sourceRoot, targetRoot);

	if (canReflink) {
		const entries = await enumerateFullTree(sourceRoot);
		if (entries !== null) {
			const fileCount = await copyEntries(sourceRoot, targetRoot, entries);
			debug.log('worktree', `Cloned ${fileCount} entries via reflink: ${targetRoot}`);
			return { mode: 'reflink', fileCount, carriedIgnoredFiles: true };
		}
		debug.warn('worktree', `Tree too large for a full clone, falling back to tracked files: ${sourceRoot}`);
	}

	const lean = await enumerateLeanTree(sourceRoot);
	const fileCount = await copyEntries(sourceRoot, targetRoot, lean);
	debug.log('worktree', `Cloned ${fileCount} tracked files: ${targetRoot}`);
	return { mode: canReflink ? 'reflink' : 'copy', fileCount, carriedIgnoredFiles: false };
}

/** Relative paths of everything under a root, split by kind. */
interface TreeEntries {
	dirs: string[];
	files: string[];
	symlinks: string[];
}

/**
 * Walk everything under `root`, including ignored files and `.git`.
 * Returns null when the tree exceeds `MAX_FULL_CLONE_ENTRIES`.
 */
async function enumerateFullTree(root: string): Promise<TreeEntries | null> {
	const entries: TreeEntries = { dirs: [], files: [], symlinks: [] };
	const queue: string[] = [''];
	let total = 0;

	while (queue.length > 0) {
		const relativeDir = queue.pop() as string;
		let dirEntries: Dirent[];
		try {
			dirEntries = await fs.readdir(path.join(root, relativeDir), { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of dirEntries) {
			if (NEVER_CLONE.has(entry.name)) continue;
			const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;

			if (++total > MAX_FULL_CLONE_ENTRIES) return null;

			if (entry.isSymbolicLink()) {
				entries.symlinks.push(relativePath);
			} else if (entry.isDirectory()) {
				entries.dirs.push(relativePath);
				queue.push(relativePath);
			} else if (entry.isFile()) {
				entries.files.push(relativePath);
			}
		}
	}

	return entries;
}

/** Tracked/untracked-not-ignored files, plus `.git` so the Git panel still works. */
async function enumerateLeanTree(root: string): Promise<TreeEntries> {
	const entries: TreeEntries = { dirs: [], files: [], symlinks: [] };
	const dirs = new Set<string>();

	const snapshotFiles = await getSnapshotFiles(root);
	for (const absolute of snapshotFiles) {
		const relativePath = path.relative(root, absolute);
		if (!relativePath || relativePath.startsWith('..')) continue;
		entries.files.push(relativePath);
		collectParentDirs(relativePath, dirs);
	}

	const gitDir = await enumerateFullTree(path.join(root, '.git'));
	if (gitDir) {
		dirs.add('.git');
		for (const dir of gitDir.dirs) dirs.add(path.join('.git', dir));
		for (const file of gitDir.files) entries.files.push(path.join('.git', file));
		for (const link of gitDir.symlinks) entries.symlinks.push(path.join('.git', link));
	}

	entries.dirs = [...dirs].sort((a, b) => a.length - b.length);
	return entries;
}

function collectParentDirs(relativePath: string, into: Set<string>): void {
	let parent = path.dirname(relativePath);
	while (parent && parent !== '.' && parent !== path.sep) {
		into.add(parent);
		parent = path.dirname(parent);
	}
}

/** Create the directories, then clone files and re-create symlinks. */
async function copyEntries(sourceRoot: string, targetRoot: string, entries: TreeEntries): Promise<number> {
	for (const relativeDir of entries.dirs) {
		await fs.mkdir(path.join(targetRoot, relativeDir), { recursive: true });
	}

	let copied = 0;

	for (const relativeFile of entries.files) {
		const source = path.join(sourceRoot, relativeFile);
		const target = path.join(targetRoot, relativeFile);
		try {
			await fs.mkdir(path.dirname(target), { recursive: true });
			// FICLONE (not FORCE): reflink where the filesystem supports it,
			// plain copy where it does not, without a second code path.
			await fs.copyFile(source, target, fsConstants.COPYFILE_FICLONE);
			copied++;
		} catch (error) {
			debug.warn('worktree', `Skipped ${relativeFile}: ${error}`);
		}
	}

	// Symlinks are re-created, never followed — following them would duplicate
	// whatever they point at and break links that are relative by design.
	for (const relativeLink of entries.symlinks) {
		try {
			const linkTarget = await fs.readlink(path.join(sourceRoot, relativeLink));
			const target = path.join(targetRoot, relativeLink);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await fs.symlink(linkTarget, target);
			copied++;
		} catch (error) {
			debug.warn('worktree', `Skipped symlink ${relativeLink}: ${error}`);
		}
	}

	return copied;
}
