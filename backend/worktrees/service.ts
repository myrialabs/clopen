/**
 * Worktree lifecycle: create, inspect, transfer, remove.
 */

import fs from 'fs/promises';
import path from 'path';
import type { Worktree } from '$shared/types/database/schema';
import type { TreeMap } from '../snapshot/blob-store';
import { projectQueries, worktreeQueries } from '../database/queries';
import { fileWatcher } from '../files/file-watcher';
import { debug } from '$shared/utils/logger';
import { cleanupWorktreeSessions } from '../terminal/ptykit';
import { browserPreviewServiceManager } from '../preview';
import { makeScopeKey } from '$shared/utils/workspace-scope';
import { cloneTree } from './clone';
import {
	applyMergePlan,
	markAutoMergeable,
	planMerge,
	type MergeEntry,
	type MergePlan,
	type MergeResolution
} from './merge';
import { getProjectWorktreesDir, getWorktreePath, uniqueWorktreeSlug } from './paths';
import { hashTree, readBlobText } from './tree';

/** Worktree → main is `apply`; main → worktree is `sync`. */
export type TransferDirection = 'apply' | 'sync';

/** Conflict previews are truncated — the dialog shows a diff, not a whole file. */
const MAX_PREVIEW_BYTES = 256 * 1024;

export interface WorktreeChange {
	path: string;
	status: MergeEntry['status'];
	conflict: boolean;
	autoMergeable: boolean;
}

export interface WorktreeConflictPreview extends WorktreeChange {
	sourceContent?: string;
	targetContent?: string;
}

export interface TransferPreview {
	direction: TransferDirection;
	changes: WorktreeChange[];
	conflicts: WorktreeConflictPreview[];
}

export interface TransferResult {
	written: number;
	deleted: number;
	skipped: number;
	failed: string[];
}

export interface WorktreeCreateResult {
	worktree: Worktree;
	fileCount: number;
	carriedIgnoredFiles: boolean;
}

/**
 * Clone the project into a new worktree.
 *
 * The base tree is hashed *after* the clone so the recorded merge base matches
 * what the worktree actually starts from, and its blobs are stored so a
 * three-way merge is still possible once both sides have moved on.
 */
export async function createWorktree(input: {
	projectId: string;
	name: string;
	createdBy?: string | null;
}): Promise<WorktreeCreateResult> {
	const project = projectQueries.getById(input.projectId);
	if (!project) throw new Error('Project not found');

	const projectExists = await pathExists(project.path);
	if (!projectExists) throw new Error(`Project path does not exist: ${project.path}`);

	const takenSlugs = new Set(worktreeQueries.getByProjectId(input.projectId).map((row) => row.slug));
	const slug = uniqueWorktreeSlug(input.name, takenSlugs);
	const targetPath = getWorktreePath(input.projectId, slug);

	if (await pathExists(targetPath)) {
		// Left behind by a crashed create — the DB row is the source of truth.
		await fs.rm(targetPath, { recursive: true, force: true });
	}
	await fs.mkdir(targetPath, { recursive: true });

	let clone;
	try {
		clone = await cloneTree(project.path, targetPath);
	} catch (error) {
		await fs.rm(targetPath, { recursive: true, force: true }).catch(() => {});
		throw error;
	}

	const baseTree = await hashTree(targetPath, true);

	const worktree = worktreeQueries.create({
		project_id: input.projectId,
		name: input.name.trim() || slug,
		slug,
		path: targetPath,
		clone_mode: clone.mode,
		base_tree: baseTree,
		created_by: input.createdBy ?? null
	});

	debug.log('worktree', `Created worktree "${worktree.name}" (${clone.mode}) at ${targetPath}`);
	return { worktree, fileCount: clone.fileCount, carriedIgnoredFiles: clone.carriedIgnoredFiles };
}

/** Delete the worktree directory and its row. Sessions fall back to the main tree. */
export async function removeWorktree(worktreeId: string): Promise<void> {
	const worktree = worktreeQueries.getById(worktreeId);
	if (!worktree) return;

	// Shells and browser tabs live in the worktree's own scope; without this they
	// would outlive the directory they were opened in.
	releaseWorkspaceScope(worktree.project_id, worktree.id);

	await fs.rm(worktree.path, { recursive: true, force: true }).catch((error) => {
		debug.warn('worktree', `Could not remove ${worktree.path}: ${error}`);
	});
	worktreeQueries.delete(worktreeId);
	debug.log('worktree', `Removed worktree ${worktree.name}`);
}

/** Remove every worktree of a project — used when the project itself is deleted. */
export async function removeProjectWorktrees(projectId: string): Promise<void> {
	for (const worktree of worktreeQueries.deleteByProjectId(projectId)) {
		releaseWorkspaceScope(projectId, worktree.id);
	}
	await fs.rm(getProjectWorktreesDir(projectId), { recursive: true, force: true }).catch(() => {});
}

/** Tear down the per-workspace resources a worktree owns. */
function releaseWorkspaceScope(projectId: string, worktreeId: string): void {
	const scopeKey = makeScopeKey(projectId, worktreeId);
	try {
		cleanupWorktreeSessions(projectId, worktreeId);
		void browserPreviewServiceManager.removeService(scopeKey);
		fileWatcher.releaseProject(scopeKey);
	} catch (error) {
		debug.warn('worktree', `Scope cleanup failed for ${scopeKey}: ${error}`);
	}
}

/**
 * Disk actually occupied by a worktree, in kilobytes.
 *
 * `du` reports allocated blocks rather than apparent size, so a reflink clone
 * correctly shows near-zero until its files are written to. Returns null where
 * `du` is unavailable (Windows) rather than reporting a misleading number.
 */
export async function getWorktreeDiskUsage(worktreePath: string): Promise<number | null> {
	if (process.platform === 'win32') return null;

	try {
		const proc = Bun.spawn(['du', '-sk', worktreePath], { stdout: 'pipe', stderr: 'ignore' });
		const output = await new Response(proc.stdout).text();
		await proc.exited;
		const kilobytes = Number.parseInt(output.trim().split(/\s+/)[0] ?? '', 10);
		return Number.isFinite(kilobytes) ? kilobytes : null;
	} catch {
		return null;
	}
}

/** Resolve which trees are source and target for a direction. */
function resolveEnds(worktree: Worktree, direction: TransferDirection) {
	const project = projectQueries.getById(worktree.project_id);
	if (!project) throw new Error('Project not found');

	return direction === 'apply'
		? { sourceRoot: worktree.path, targetRoot: project.path }
		: { sourceRoot: project.path, targetRoot: worktree.path };
}

/** Build the plan for a transfer, hashing both live trees against the stored base. */
async function buildPlan(
	worktree: Worktree,
	direction: TransferDirection
): Promise<{ plan: MergePlan; sourceRoot: string; targetRoot: string; baseTree: TreeMap }> {
	const { sourceRoot, targetRoot } = resolveEnds(worktree, direction);
	const baseTree = worktreeQueries.parseBaseTree(worktree);

	const [sourceTree, targetTree] = await Promise.all([hashTree(sourceRoot), hashTree(targetRoot)]);

	const plan = await markAutoMergeable(
		planMerge(baseTree, sourceTree, targetTree),
		sourceRoot,
		targetRoot
	);

	return { plan, sourceRoot, targetRoot, baseTree };
}

/** What a transfer would do, including previews for every file needing a decision. */
export async function previewTransfer(
	worktreeId: string,
	direction: TransferDirection
): Promise<TransferPreview> {
	const worktree = requireWorktree(worktreeId);
	const { plan, sourceRoot, targetRoot } = await buildPlan(worktree, direction);

	const changes: WorktreeChange[] = plan.entries.map((entry) => ({
		path: entry.path,
		status: entry.status,
		conflict: entry.conflict,
		autoMergeable: entry.autoMergeable
	}));

	const conflicts: WorktreeConflictPreview[] = [];
	for (const entry of plan.conflicts) {
		conflicts.push({
			path: entry.path,
			status: entry.status,
			conflict: true,
			autoMergeable: entry.autoMergeable,
			sourceContent: await previewContent(sourceRoot, entry.path, entry.sourceHash),
			targetContent: await previewContent(targetRoot, entry.path, entry.targetHash)
		});
	}

	return { direction, changes, conflicts };
}

/**
 * Run the transfer, then re-base the worktree onto the main tree as it now
 * stands. Without the re-base every later transfer would re-propose the same
 * files, including the ones the user deliberately declined.
 */
export async function executeTransfer(
	worktreeId: string,
	direction: TransferDirection,
	resolutions: Record<string, MergeResolution>
): Promise<TransferResult> {
	const worktree = requireWorktree(worktreeId);
	const { plan, sourceRoot, targetRoot } = await buildPlan(worktree, direction);

	const applied = await applyMergePlan(plan, sourceRoot, targetRoot, resolutions);

	const project = projectQueries.getById(worktree.project_id);
	const newBase = project ? await hashTree(project.path, true) : null;

	if (newBase) {
		if (direction === 'apply') {
			worktreeQueries.markApplied(worktreeId, newBase);
		} else {
			worktreeQueries.updateBaseTree(worktreeId, newBase);
		}
	}

	debug.log(
		'worktree',
		`Transfer ${direction} on ${worktree.name}: ${applied.written.length} written, ${applied.deleted.length} deleted, ${applied.skipped.length} skipped`
	);

	return {
		written: applied.written.length,
		deleted: applied.deleted.length,
		skipped: applied.skipped.length,
		failed: applied.failed
	};
}

/** Count of files a worktree has diverged by, for the manager list. */
export async function countPendingChanges(worktreeId: string): Promise<number> {
	const worktree = worktreeQueries.getById(worktreeId);
	if (!worktree) return 0;

	try {
		const { plan } = await buildPlan(worktree, 'apply');
		return plan.entries.length;
	} catch {
		return 0;
	}
}

function requireWorktree(worktreeId: string): Worktree {
	const worktree = worktreeQueries.getById(worktreeId);
	if (!worktree) throw new Error('Worktree not found');
	return worktree;
}

/** Current content of one side, falling back to the blob when the file is gone. */
async function previewContent(
	root: string,
	relativePath: string,
	hash: string | null
): Promise<string | undefined> {
	if (hash === null) return undefined;

	try {
		const buffer = await fs.readFile(path.join(root, relativePath));
		if (buffer.includes(0)) return '(binary file)';
		return buffer.subarray(0, MAX_PREVIEW_BYTES).toString('utf-8');
	} catch {
		const text = await readBlobText(hash);
		return text ?? undefined;
	}
}

async function pathExists(target: string): Promise<boolean> {
	try {
		await fs.access(target);
		return true;
	} catch {
		return false;
	}
}
