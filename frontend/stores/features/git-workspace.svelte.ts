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
import { isScopeOfProject } from '$shared/utils/workspace-scope';
import ws, { onWsReconnect } from '$frontend/utils/ws';
import { showError } from '$frontend/stores/ui/notification.svelte';
import { debug } from '$shared/utils/logger';
import type { GitActiveOp, GitOpCategory, GitOpClass, GitRepoOpState } from '$shared/types/git';

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
// AI generation) and the Changes section's bulk buttons (stage/unstage/discard
// all). Keyed by projectId — and by repoPath for anything a nested sub-repo can
// run on its own — so an operation started for one project keeps its spinner,
// and clears the right project's flag, regardless of which project is active
// when it resolves.
export interface GitOpFlags {
	isCommitting: boolean;
	/** A bulk stage/unstage/discard is running against this repo. */
	isStaging: boolean;
	isPushing: boolean;
	isPulling: boolean;
	isFetching: boolean;
	isMoreBusy: boolean;
	isGenerating: boolean;
	isGeneratingBranch: boolean;
	isCreatingBranch: boolean;
	/** Stash save / pop / drop. */
	isStashing: boolean;
	/** Tag create / delete / push. */
	isTagging: boolean;
	/** Branch switch / create / rename / delete, and commit checkout. */
	isBranching: boolean;
	/** Conflict resolution and merge abort. */
	isResolving: boolean;
	/** Repo setup that is not a working-tree change: init, remote add/edit/remove. */
	isConfiguring: boolean;
}

const NO_OPS: GitOpFlags = Object.freeze({
	isCommitting: false,
	isStaging: false,
	isPushing: false,
	isPulling: false,
	isFetching: false,
	isMoreBusy: false,
	isGenerating: false,
	isGeneratingBranch: false,
	isCreatingBranch: false,
	isStashing: false,
	isTagging: false,
	isBranching: false,
	isResolving: false,
	isConfiguring: false
});

type GitOpFlag = keyof GitOpFlags;

/** The flag each server-side operation category lights up. */
const CATEGORY_FLAG: Record<GitOpCategory, GitOpFlag> = {
	commit: 'isCommitting',
	staging: 'isStaging',
	push: 'isPushing',
	pull: 'isPulling',
	fetch: 'isFetching',
	more: 'isMoreBusy',
	stash: 'isStashing',
	tag: 'isTagging',
	branch: 'isBranching',
	resolve: 'isResolving',
	configure: 'isConfiguring'
};

/**
 * The lock class of each flag, mirroring the server's defaults
 * (`backend/git/op-lock.ts`). Flags without one — AI generation, UI wrappers —
 * never touch the repository themselves and never block anything.
 */
const FLAG_CLASS: Partial<Record<GitOpFlag, GitOpClass>> = {
	isCommitting: 'exclusive',
	isStaging: 'index',
	isPushing: 'network',
	isPulling: 'exclusive',
	isFetching: 'network',
	isMoreBusy: 'exclusive',
	isStashing: 'exclusive',
	isTagging: 'network',
	isBranching: 'exclusive',
	isResolving: 'exclusive',
	isConfiguring: 'exclusive'
	// `isCreatingBranch` has no class on purpose: it only wraps the form while
	// `createBranch` runs, and that holds `isBranching` itself — giving the
	// wrapper a class would make the branch creation refuse its own wrapper.
};

const FLAG_LABEL: Record<GitOpFlag, string> = {
	isCommitting: 'Commit',
	isStaging: 'Staging',
	isPushing: 'Push',
	isPulling: 'Pull',
	isFetching: 'Fetch',
	isMoreBusy: 'A git action',
	isGenerating: 'Message generation',
	isGeneratingBranch: 'Branch name generation',
	isCreatingBranch: 'Create branch',
	isStashing: 'Stash',
	isTagging: 'Tag',
	isBranching: 'A branch change',
	isResolving: 'Conflict resolution',
	isConfiguring: 'Repository setup'
};

/**
 * Two operations conflict when either is exclusive or both share a class —
 * except index writes, which the server queues behind each other instead of
 * refusing, so the client must not refuse them either.
 */
function classesConflict(a: GitOpClass, b: GitOpClass): boolean {
	if (a === 'index' && b === 'index') return false;
	return a === 'exclusive' || b === 'exclusive' || a === b;
}

// What THIS tab has in flight — set the moment a button is clicked, before the
// server has answered, so the spinner never waits on a round trip.
const gitOps = $state<Record<string, GitOpFlags>>({});
const localTargets = $state<Record<string, Partial<Record<GitOpFlag, string>>>>({});

// What the repository's lock says, from every client. This is the shared truth:
// a pull started on another device, or in this tab before a remount, shows here.
interface ServerOpEntry {
	scope: string;
	ops: GitActiveOp[];
}
const serverOps = $state<Record<string, ServerOpEntry>>({});

function getOpKey(projectId: string, repoPath?: string): string {
	return repoPath ? `${projectId}::${repoPath}` : projectId;
}

/** Read a repo's operation flags: this tab's own plus every client's, via the server. */
export function getGitOps(projectId: string, repoPath?: string): GitOpFlags {
	const key = getOpKey(projectId, repoPath);
	const local = gitOps[key] ?? NO_OPS;
	const remote = serverOps[key]?.ops;
	if (!remote || remote.length === 0) return local;
	const merged: GitOpFlags = { ...local };
	for (const op of remote) merged[CATEGORY_FLAG[op.category]] = true;
	return merged;
}

/**
 * What a running operation of `flag` is aimed at — the branch being pushed,
 * the remote being fetched. Rows use it to spin only the item that is busy.
 * `null` when the flag is idle; `undefined` target when it has none (fetch all).
 */
export function getGitOpTarget(
	projectId: string,
	flag: GitOpFlag,
	repoPath?: string
): { target?: string } | null {
	const key = getOpKey(projectId, repoPath);
	const remote = serverOps[key]?.ops.find(op => CATEGORY_FLAG[op.category] === flag);
	if (remote) return { target: remote.target };
	if (gitOps[key]?.[flag]) return { target: localTargets[key]?.[flag] };
	return null;
}

/**
 * Why `flag` cannot start right now, or null when it can. Covers its own
 * operation already running and any conflicting one, from this tab or another
 * client. Buttons render this as their disabled state and tooltip, so a click
 * that would be refused is never a click that silently does nothing.
 */
export function getGitBusyReason(projectId: string, flag: GitOpFlag, repoPath?: string): string | null {
	if (!projectId) return null;
	const key = getOpKey(projectId, repoPath);
	const cls = FLAG_CLASS[flag];
	const local = gitOps[key];
	if (local?.[flag]) return `${FLAG_LABEL[flag]} is running…`;
	const remote = serverOps[key]?.ops ?? [];
	const own = remote.find(op => CATEGORY_FLAG[op.category] === flag);
	if (own) return `${own.label}${own.target ? ` (${own.target})` : ''} is running…`;
	if (!cls) return null;
	for (const op of remote) {
		if (classesConflict(op.cls, cls)) {
			return `Waiting for ${op.label}${op.target ? ` (${op.target})` : ''} to finish`;
		}
	}
	if (local) {
		for (const other of Object.keys(local) as GitOpFlag[]) {
			const otherCls = FLAG_CLASS[other];
			if (local[other] && otherCls && classesConflict(otherCls, cls)) {
				return `Waiting for ${FLAG_LABEL[other]} to finish`;
			}
		}
	}
	return null;
}

/** Set a single operation flag for a project. */
export function setGitOp(projectId: string, key: GitOpFlag, value: boolean, repoPath?: string): void {
	if (!projectId) return;
	const opKey = getOpKey(projectId, repoPath);
	const current = gitOps[opKey] ?? NO_OPS;
	gitOps[opKey] = { ...current, [key]: value };
}

/**
 * Run one git action while its flag is held, and skip it entirely if that flag
 * is already set or a conflicting operation is running. Returns whether the
 * action ran.
 *
 * Every mutating git action in the panel goes through this. Hand-rolling the
 * check-set-try-finally at each call site is how they drifted apart: of the
 * panel's fifty mutating handlers, most held no flag at all, so a second click
 * during a slow refresh fired the request twice. That was merely wasteful for
 * something idempotent like `git add`, and destructive for anything addressed
 * by position — `git stash pop stash@{0}` twice pops two different stashes,
 * because the list re-indexes under the second call.
 *
 * Only checking the action's own flag was the other half of the problem: a
 * pull from the Branches tab started while a push from the Changes tab still
 * ran. Conflicts are now judged by lock class, against this tab's operations
 * and every other client's (the server enforces the same rule; this check
 * only saves the round trip and explains the refusal).
 *
 * The flag is per (projectId, repoPath), so a nested sub-repo runs
 * independently of its parent and an action started in one project clears the
 * right flag even if the user switches away mid-flight.
 *
 * Callers must render the flag — a disabled button or a spinner. A guard that
 * nothing displays turns a double-click into a click that silently does
 * nothing, which is worse than the duplicate request it prevents.
 */
export async function runGitOp(
	projectId: string | null | undefined,
	key: GitOpFlag,
	action: () => Promise<void>,
	repoPath?: string,
	target?: string
): Promise<boolean> {
	if (!projectId) return false;
	const opKey = getOpKey(projectId, repoPath);
	if (gitOps[opKey]?.[key]) return false;
	const reason = getGitBusyReason(projectId, key, repoPath);
	if (reason) {
		showError('Git is busy', `${reason}. Try again when it is done.`);
		return false;
	}
	setGitOp(projectId, key, true, repoPath);
	localTargets[opKey] = { ...localTargets[opKey], [key]: target };
	try {
		await action();
		return true;
	} finally {
		setGitOp(projectId, key, false, repoPath);
		const targets = { ...localTargets[opKey] };
		delete targets[key];
		localTargets[opKey] = targets;
	}
}

/** Apply one repository's lock state as broadcast by the server. */
function applyGitOpState(state: GitRepoOpState): void {
	const key = getOpKey(state.scope, state.repoPath);
	if (state.ops.length === 0) delete serverOps[key];
	else serverOps[key] = { scope: state.scope, ops: state.ops };
}

/**
 * Replace a workspace's server lock state with a fresh snapshot. Events sent
 * while the socket was down, or while no Git panel listened, are gone — the
 * snapshot is what makes a spinner that missed its "done" event stop.
 */
export async function syncGitOpStates(projectId: string, scope: string): Promise<void> {
	if (!projectId || !scope) return;
	try {
		const states = await ws.http('git:op-states', { projectId });
		for (const key of Object.keys(serverOps)) {
			if (serverOps[key].scope === scope) delete serverOps[key];
		}
		for (const state of states) applyGitOpState(state);
	} catch (err) {
		debug.warn('git', 'Could not read git operation state:', err);
	}
}

let opSyncStarted = false;

/**
 * Listen for lock changes from the server. Idempotent; the listener lives for
 * the session so a Git panel that remounts finds the state already current.
 */
export function initGitOpSync(resync: () => void): () => void {
	if (!opSyncStarted) {
		opSyncStarted = true;
		ws.on('git:op-state', (state) => applyGitOpState(state));
	}
	return onWsReconnect(resync);
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
	// Entries are keyed per workspace, so a project's worktrees have their own —
	// deleting the project id alone would strand them.
	for (const key of [...pending.keys()]) {
		if (isScopeOfProject(key, projectId)) pending.delete(key);
	}
	for (const key of Object.keys(commitDrafts)) {
		if (isScopeOfProject(key, projectId)) delete commitDrafts[key];
	}
	for (const key of Object.keys(gitOps)) {
		if (isScopeOfProject(key, projectId)) delete gitOps[key];
	}
	for (const key of Object.keys(serverOps)) {
		if (isScopeOfProject(serverOps[key].scope, projectId)) delete serverOps[key];
	}
});
