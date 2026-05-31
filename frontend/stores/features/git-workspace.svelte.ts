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

export type GitView = 'changes' | 'log' | 'stash' | 'tags';

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
}

export function defaultGitUiState(): GitUiState {
	return {
		activeView: 'changes',
		leftPanelWidth: 256,
		selectedRemote: 'origin',
		commitMessage: '',
		selectedCommitHash: null,
		activeDiff: null
	};
}

// Server slices restored by the coordinator, awaiting the panel to activate the
// project. The coordinator's own per-project `cache` provides in-session A→B→A
// persistence, so we deliberately do NOT keep a second cache here (a duplicate
// cache is what previously let a cleared draft clobber the saved one).
const pending = new Map<string, GitUiState>();

// Commit-message draft for the ACTIVE project, shared with CommitForm.
export const gitDraft = $state<{ commitMessage: string }>({ commitMessage: '' });

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

registerDock({
	id: 'git',
	clear() {
		// Reset the shared draft so the previous project's message can't leak
		// into the new project's commit box during the switch.
		gitDraft.commitMessage = '';
	},
	snapshot() {
		return snapshotProvider ? snapshotProvider() : undefined;
	},
	restore(slice) {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;
		if (slice && typeof slice === 'object') {
			pending.set(projectId, { ...defaultGitUiState(), ...(slice as Partial<GitUiState>) });
		} else {
			pending.delete(projectId);
		}
	}
});

registerProjectCleanup((projectId) => {
	pending.delete(projectId);
});
