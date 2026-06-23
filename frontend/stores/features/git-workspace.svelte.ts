/**
 * Git Dock Workspace State
 *
 * Per-project view state for the Git dock so switching projects preserves and
 * restores each project's git view exactly (which tab was open, the commit
 * message draft, the diff panel width, the selected remote) and never shows
 * another project's data.
 *
 * Two layers:
 *  - `memory`  — in-session cache keyed by projectId, so A→B→A is instant.
 *  - server    — the coordinator persists a lightweight slice per project, so
 *                the view survives a full refresh / follows the user's devices.
 *
 * Heavy data (open diff contents, commit history) is intentionally NOT stored
 * here — it is re-fetched lazily when the view is shown.
 *
 * The commit-message draft is exposed as the reactive `gitDraft` so `CommitForm`
 * (a separate component that remounts often) can bind to it directly.
 */

import {
	registerDock,
	requestWorkspaceSave,
	getActiveWorkspaceProjectId
} from '$frontend/stores/ui/project-workspace.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

export type GitView = 'changes' | 'log' | 'branches' | 'more';

/**
 * The diff tab open in the active view (the file the user picked from Changes or
 * a commit's file list). Re-opened lazily on restore by re-fetching its diff —
 * the heavy diff content itself is never stored.
 */
export interface GitActiveDiff {
	/** 'staged' | 'unstaged' | 'conflicted' | 'commit'. */
	section: string;
	filePath: string;
	/** Set when section === 'commit' — the commit the file belongs to. */
	commitHash?: string;
	/** Vertical scroll position of the diff editor, restored on re-open. */
	scrollTop?: number;
}

export interface GitUiState {
	activeView: GitView;
	leftPanelWidth: number;
	selectedRemote: string;
	commitMessage: string;
	/** Hash of the commit whose detail was open in History (re-fetched lazily). */
	selectedCommitHash: string | null;
	/** The diff tab open in the active view (re-fetched lazily). */
	activeDiff: GitActiveDiff | null;
	/** Height of the resizable nested repos panel in the Branches view. */
	nestedReposHeight: number;
	/** Heights of the resizable nested repos panels in the Branches view. */
	nestedReposHeights?: Record<string, number>;
}

export function defaultGitUiState(): GitUiState {
	return {
		activeView: 'changes',
		leftPanelWidth: 256,
		selectedRemote: 'origin',
		commitMessage: '',
		selectedCommitHash: null,
		activeDiff: null,
		nestedReposHeight: 473,
		nestedReposHeights: {}
	};
}

// Server slices restored by the coordinator, awaiting the panel to activate the
// project. The coordinator's own per-project `cache` provides in-session A→B→A
// persistence, so we deliberately do NOT keep a second cache here (a duplicate
// cache is what previously let a cleared draft clobber the saved one).
const pending = new Map<string, GitUiState>();

// Commit-message draft for the ACTIVE project, shared with CommitForm via a
// direct `bind:value`. It is only a mirror — the per-project source of truth is
// `commitDrafts` below, so a generation that finishes after the user switched
// away routes its result to the originating project, not whatever is active now.
export const gitDraft = $state<{ commitMessage: string }>({ commitMessage: '' });

// Per-project commit-message drafts, keyed by projectId. In-session source of
// truth: survives project switches and panel remounts, and lets a background
// AI generation write back to the project it was started for.
const commitDrafts = $state<Record<string, string>>({});

/** Whether an in-session draft entry exists for a project (vs never seeded). */
export function hasCommitDraft(projectId: string): boolean {
	return projectId in commitDrafts;
}

/** Read a project's commit draft (empty string when none). */
export function getCommitDraft(projectId: string): string {
	return commitDrafts[projectId] ?? '';
}

/** Write a project's commit draft (and mirror it when that project is active). */
export function setCommitDraft(projectId: string, message: string): void {
	if (!projectId) return;
	commitDrafts[projectId] = message;
	if (getActiveWorkspaceProjectId() === projectId) gitDraft.commitMessage = message;
}

/**
 * Apply an AI-generated commit message to the project it was generated for.
 * Routes to that project's stored draft and only touches the live mirror when
 * the project is still the active one — so a generation that finishes after a
 * project switch never leaks into the current project's commit box.
 */
export function applyGeneratedCommitMessage(projectId: string, message: string): void {
	setCommitDraft(projectId, message);
}

// ============================================================
// Per-project git operation flags
// ============================================================
//
// Busy state for the action-bar buttons (commit / push / pull / fetch / more /
// AI generation). Keyed by projectId so an operation started for one project
// keeps its spinner — and clears the right project's flag — regardless of which
// project is active when it resolves.
export interface GitOpFlags {
	isCommitting: boolean;
	isPushing: boolean;
	isPulling: boolean;
	isFetching: boolean;
	isMoreBusy: boolean;
	isGenerating: boolean;
	isGeneratingBranch: boolean;
	isCreatingBranch: boolean;
}

const NO_OPS: GitOpFlags = Object.freeze({
	isCommitting: false,
	isPushing: false,
	isPulling: false,
	isFetching: false,
	isMoreBusy: false,
	isGenerating: false,
	isGeneratingBranch: false,
	isCreatingBranch: false
});

const gitOps = $state<Record<string, GitOpFlags>>({});

function getOpKey(projectId: string, repoPath?: string): string {
	return repoPath ? `${projectId}::${repoPath}` : projectId;
}

/** Read a project's operation flags (all-false sentinel when none). */
export function getGitOps(projectId: string, repoPath?: string): GitOpFlags {
	const key = getOpKey(projectId, repoPath);
	return gitOps[key] ?? NO_OPS;
}

/** Set a single operation flag for a project. */
export function setGitOp(projectId: string, key: keyof GitOpFlags, value: boolean, repoPath?: string): void {
	if (!projectId) return;
	const opKey = getOpKey(projectId, repoPath);
	const current = gitOps[opKey] ?? NO_OPS;
	gitOps[opKey] = { ...current, [key]: value };
}

let snapshotProvider: (() => GitUiState) | null = null;

/** GitPanel registers a provider so the coordinator can snapshot live state. */
export function setGitSnapshotProvider(fn: (() => GitUiState) | null): void {
	snapshotProvider = fn;
}

/**
 * Load a project's git view from the slice the coordinator restored (server or
 * its in-session cache), else null (caller falls back to defaults).
 */
export function loadGitUiState(projectId: string): GitUiState | null {
	return pending.get(projectId) ?? null;
}

/** Schedule a debounced server save of the active project's git view. */
export function markGitUiDirty(): void {
	requestWorkspaceSave();
}

/**
 * Capture the active project's live git view into the in-session `pending` slice.
 *
 * Called when GitPanel unmounts on a panel swap (Git → Files → Git). Project
 * switches persist through the coordinator's snapshot → cache → restore path, but
 * a panel swap unmounts the component without going through the coordinator — so
 * without this, the next remount would restore the stale activation-time slice
 * and the active tab/diff would reset to defaults.
 */
export function captureActiveGitUiState(): void {
	const projectId = getActiveWorkspaceProjectId();
	if (!projectId || !snapshotProvider) return;
	pending.set(projectId, snapshotProvider());
}

registerDock({
	id: 'git',
	clear() {
		// Reset the shared draft so the previous project's message can't leak
		// into the new project's commit box during the switch.
		gitDraft.commitMessage = '';
	},
	snapshot() {
		if (snapshotProvider) return snapshotProvider();
		// Provider detached (Git panel currently unmounted): fall back to the last
		// captured slice so a project switch while the panel is hidden still
		// persists its view instead of dropping the git slice.
		const projectId = getActiveWorkspaceProjectId();
		return projectId ? pending.get(projectId) : undefined;
	},
	restore(slice) {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;
		if (slice && typeof slice === 'object') {
			const merged = { ...defaultGitUiState(), ...(slice as Partial<GitUiState>) };
			// Migrate the former 'tags' view (now merged into the 'more' tab).
			if ((merged.activeView as string) === 'tags') merged.activeView = 'more';
			pending.set(projectId, merged);
		} else {
			pending.delete(projectId);
		}
	}
});

registerProjectCleanup((projectId) => {
	pending.delete(projectId);
	delete commitDrafts[projectId];
	delete gitOps[projectId];
});
