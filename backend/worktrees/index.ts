/**
 * Worktrees — isolated copies of a project that chat sessions can run in.
 *
 * `branching/` is re-exported from here so importing this module is what wires
 * the `worktree-branching` capability up — the same side-effect registration
 * `backend/db-client/integrations/` does for `database`.
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

export { worktreeBranching } from './branching';
export type { BranchProviderAdapter, BranchProviderContext } from './branching';
