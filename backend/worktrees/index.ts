/**
 * Worktrees — isolated copies of a project that chat sessions can run in.
 */

export {
	createWorktree,
	countPendingChanges,
	executeTransfer,
	getWorktreeDiskUsage,
	previewTransfer,
	removeProjectWorktrees,
	removeWorktree,
	type TransferDirection,
	type TransferPreview,
	type TransferResult,
	type WorktreeChange,
	type WorktreeConflictPreview,
	type WorktreeCreateResult
} from './service';

export {
	resolveSessionPath,
	resolveSessionRoot,
	resolveWorktreeRoot,
	type SessionRoot
} from './resolve';

export { planMerge, type MergeEntry, type MergePlan, type MergeResolution } from './merge';
export { getProjectWorktreesDir, getWorktreePath, getWorktreesRootDir, isPathInside, slugifyWorktreeName, uniqueWorktreeSlug } from './paths';
