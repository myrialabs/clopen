/**
 * Three-way merge between a worktree and the main tree.
 *
 * The merge base is the tree recorded when the worktree was cloned, so a file
 * is only in play when the source side actually changed it. When the target
 * side changed the same file the entry is a conflict — resolvable line-by-line
 * through `git merge-file` when both sides are text, and whole-file otherwise.
 *
 * `source` and `target` are direction-agnostic: applying runs worktree → main,
 * syncing runs main → worktree, and both use this same planner.
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { TreeMap } from '../snapshot/blob-store';
import { execGit } from '../git/git-executor';
import { resolveBinary } from '../utils/cli';
import { debug } from '$shared/utils/logger';
import { readBlobText } from './tree';

export type MergeEntryStatus = 'added' | 'modified' | 'deleted';

/** What to do with one file: take the source side, keep the target, or merge both. */
export type MergeResolution = 'source' | 'target' | 'merge';

export interface MergeEntry {
	path: string;
	status: MergeEntryStatus;
	baseHash: string | null;
	sourceHash: string | null;
	targetHash: string | null;
	/** Target also moved away from the base, so taking the source would discard work. */
	conflict: boolean;
	/** A clean line-level merge of both sides is available. */
	autoMergeable: boolean;
}

export interface MergePlan {
	entries: MergeEntry[];
	conflicts: MergeEntry[];
}

/**
 * Decide which files transfer from source to target.
 *
 * Pure: the three trees are all it reads, which is what makes the interesting
 * cases (both sides identical, both sides deleted, target-only edits) testable
 * without touching a disk.
 */
export function planMerge(base: TreeMap, source: TreeMap, target: TreeMap): MergePlan {
	const paths = new Set<string>([
		...Object.keys(base),
		...Object.keys(source),
		...Object.keys(target)
	]);

	const entries: MergeEntry[] = [];

	for (const filePath of [...paths].sort()) {
		const baseHash = base[filePath] ?? null;
		const sourceHash = source[filePath] ?? null;
		const targetHash = target[filePath] ?? null;

		// The source side never touched this file — nothing to carry over.
		if (sourceHash === baseHash) continue;

		// Both sides landed on the same content; the transfer is already done.
		if (sourceHash === targetHash) continue;

		const status: MergeEntryStatus =
			sourceHash === null ? 'deleted' : baseHash === null ? 'added' : 'modified';

		entries.push({
			path: filePath,
			status,
			baseHash,
			sourceHash,
			targetHash,
			conflict: targetHash !== baseHash,
			autoMergeable: false
		});
	}

	return { entries, conflicts: entries.filter((entry) => entry.conflict) };
}

/**
 * Mark conflicts that `git merge-file` can resolve on its own.
 * Runs before the user is asked anything, so the dialog only shows the files
 * that genuinely need a decision.
 */
export async function markAutoMergeable(
	plan: MergePlan,
	sourceRoot: string,
	targetRoot: string
): Promise<MergePlan> {
	if (!resolveBinary('git')) return plan;

	for (const entry of plan.conflicts) {
		// A deletion on either side has no text to merge.
		if (entry.status === 'deleted' || entry.targetHash === null) continue;
		const merged = await mergeFileContents(entry, sourceRoot, targetRoot);
		entry.autoMergeable = merged !== null;
	}

	return plan;
}

/**
 * Three-way merge one file's text. Returns null when it cannot be merged
 * cleanly — conflicting edits, a missing base blob, or binary content.
 */
export async function mergeFileContents(
	entry: MergeEntry,
	sourceRoot: string,
	targetRoot: string
): Promise<string | null> {
	if (entry.baseHash === null || entry.sourceHash === null || entry.targetHash === null) {
		return null;
	}

	const baseText = await readBlobText(entry.baseHash);
	if (baseText === null) return null;

	const sourceText = await readText(path.join(sourceRoot, entry.path));
	const targetText = await readText(path.join(targetRoot, entry.path));
	if (sourceText === null || targetText === null) return null;

	const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'clopen-merge-'));
	try {
		const currentFile = path.join(scratch, 'current');
		const baseFile = path.join(scratch, 'base');
		const otherFile = path.join(scratch, 'other');

		await Promise.all([
			fs.writeFile(currentFile, targetText),
			fs.writeFile(baseFile, baseText),
			fs.writeFile(otherFile, sourceText)
		]);

		// `-p` prints the result instead of rewriting `current`; a non-zero exit
		// is the conflict count, not a failure to run.
		const result = await execGit(
			['merge-file', '-p', currentFile, baseFile, otherFile],
			scratch,
			{ okExitCodes: [1] }
		);

		return result.exitCode === 0 ? result.stdout : null;
	} catch (error) {
		debug.warn('worktree', `merge-file failed for ${entry.path}: ${error}`);
		return null;
	} finally {
		await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
	}
}

/** Read a file as text, or null when it is missing or contains a NUL byte. */
async function readText(filePath: string): Promise<string | null> {
	try {
		const buffer = await fs.readFile(filePath);
		if (buffer.includes(0)) return null;
		return buffer.toString('utf-8');
	} catch {
		return null;
	}
}

export interface MergeApplyResult {
	written: string[];
	deleted: string[];
	skipped: string[];
	failed: string[];
}

/**
 * Carry the planned changes into `targetRoot`.
 *
 * `resolutions` only has to cover conflicts; clean entries default to taking
 * the source side, which is the whole point of the transfer.
 */
export async function applyMergePlan(
	plan: MergePlan,
	sourceRoot: string,
	targetRoot: string,
	resolutions: Record<string, MergeResolution> = {}
): Promise<MergeApplyResult> {
	const result: MergeApplyResult = { written: [], deleted: [], skipped: [], failed: [] };

	for (const entry of plan.entries) {
		const resolution: MergeResolution = entry.conflict
			? resolutions[entry.path] ?? 'target'
			: 'source';

		if (resolution === 'target') {
			result.skipped.push(entry.path);
			continue;
		}

		const targetPath = path.join(targetRoot, entry.path);

		try {
			if (resolution === 'merge') {
				const merged = await mergeFileContents(entry, sourceRoot, targetRoot);
				if (merged === null) {
					result.failed.push(entry.path);
					continue;
				}
				await fs.mkdir(path.dirname(targetPath), { recursive: true });
				await fs.writeFile(targetPath, merged);
				result.written.push(entry.path);
				continue;
			}

			if (entry.status === 'deleted') {
				await fs.rm(targetPath, { force: true });
				result.deleted.push(entry.path);
				continue;
			}

			await fs.mkdir(path.dirname(targetPath), { recursive: true });
			await fs.copyFile(path.join(sourceRoot, entry.path), targetPath);
			result.written.push(entry.path);
		} catch (error) {
			debug.warn('worktree', `Failed to transfer ${entry.path}: ${error}`);
			result.failed.push(entry.path);
		}
	}

	return result;
}
