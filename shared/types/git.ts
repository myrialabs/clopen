/**
 * Git Types
 * Shared types for git operations between frontend and backend
 */

// ============================================
// File Status Types
// ============================================

/** Git file status codes (from git status --porcelain=v1) */
export type GitFileStatus =
	| 'M'   // Modified
	| 'A'   // Added
	| 'D'   // Deleted
	| 'R'   // Renamed
	| 'C'   // Copied
	| 'U'   // Unmerged
	| '?'   // Untracked
	| '!'   // Ignored
	| 'T';  // Type changed

/** A single file change entry */
export interface GitFileChange {
	path: string;
	/** Status in the index (staging area) */
	indexStatus: string;
	/** Status in the working tree */
	workingStatus: string;
	/** Original path (for renames) */
	oldPath?: string;
}

/** Categorized file changes */
export interface GitStatus {
	staged: GitFileChange[];
	unstaged: GitFileChange[];
	untracked: GitFileChange[];
	conflicted: GitFileChange[];
}

// ============================================
// Branch Types
// ============================================

export interface GitBranch {
	name: string;
	isCurrent: boolean;
	isRemote: boolean;
	/**
	 * The branch this one tracks, e.g. `origin/main`. Populated from
	 * `%(upstream:short)`, or from `branch.<name>.remote`/`.merge` when the
	 * configured remote is a bare URL — which is what `gh pr checkout` writes for
	 * a fork PR, and which has no remote-tracking ref for git to name.
	 */
	upstream?: string;
	ahead: number;
	behind: number;
	lastCommit?: string;
	/** Commit subject of the branch tip */
	lastCommitMessage?: string;
	/** ISO 8601 committer date of the branch tip, for "created/updated X ago" UI */
	lastCommitDate?: string;
}

/** In-progress git operation that leaves the repo in a detached/transitional state */
export type GitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert' | 'bisect';

export interface GitBranchInfo {
	/** Active branch name, or a short commit hash when HEAD is detached */
	current: string;
	local: GitBranch[];
	remote: GitBranch[];
	ahead: number;
	behind: number;
	/** True when HEAD is detached (no branch checked out) */
	detached?: boolean;
	/** The in-progress operation, if any (rebase, merge, …) */
	operation?: GitOperation | null;
	/** Nested git repos / submodules under this project */
	nested?: GitNestedRepoInfo[];
	/** The repo declares submodules (`.gitmodules` exists). */
	hasSubmodules?: boolean;
	/** The repo root has a `package.json`, so `npm version` can run. */
	hasPackageJson?: boolean;
}

/**
 * A nested git repo discovered under the project root. Used by the Branches
 * tab to render one collapsible group per sub-repo, and by branch operations
 * (create / switch / delete) when the target branch lives inside one of these.
 */
export interface GitNestedRepoInfo {
	/** Absolute path to the nested repo on disk */
	path: string;
	/** Path relative to the outer project root, e.g. "packages/web" */
	relPath: string;
	/** True when registered in the outer repo's `.gitmodules` */
	isSubmodule: boolean;
	/** Branches inside this repo (same shape as the outer repo) */
	info: GitBranchInfo;
	/** Populated when the nested repo could not be read (e.g. not initialized) */
	error?: string;
}

// ============================================
// Diff Types
// ============================================

export interface GitDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	header: string;
	lines: GitDiffLine[];
}

export interface GitDiffLine {
	type: 'add' | 'delete' | 'context' | 'header';
	content: string;
	oldLineNumber?: number;
	newLineNumber?: number;
}

export interface GitFileDiff {
	oldPath: string;
	newPath: string;
	status: string;
	hunks: GitDiffHunk[];
	isBinary: boolean;
}

// ============================================
// Commit / Log Types
// ============================================

export interface GitCommit {
	hash: string;
	hashShort: string;
	author: string;
	authorEmail: string;
	date: string;
	message: string;
	parents: string[];
	refs?: string[];
}

export interface GitLogResult {
	commits: GitCommit[];
	total: number;
	hasMore: boolean;
}

export interface GitCommitDiff {
	files: GitFileDiff[];
	subject: string;
	body: string;
}

// ============================================
// Conflict Types
// ============================================

export interface GitConflictMarker {
	ourStart: number;
	ourEnd: number;
	theirStart: number;
	theirEnd: number;
	baseStart?: number;
	baseEnd?: number;
	ourContent: string;
	theirContent: string;
	baseContent?: string;
}

/**
 * How git recorded the conflict, derived from the porcelain XY code. Only
 * `both-modified` and `both-added` carry inline `<<<<<<<` markers; the rest are
 * add/delete disagreements where the only meaningful answer is "keep the file"
 * or "delete the file", which is why they need their own UI affordance.
 */
export type GitConflictKind =
	| 'both-modified'   // UU
	| 'both-added'      // AA
	| 'added-by-us'     // AU
	| 'added-by-them'   // UA
	| 'deleted-by-us'   // DU
	| 'deleted-by-them' // UD
	| 'both-deleted';   // DD

/** Ways a single conflicted path can be resolved. */
export type GitConflictResolution =
	/** Take the whole file from our side (`git checkout --ours`). */
	| 'ours'
	/** Take the whole file from their side (`git checkout --theirs`). */
	| 'theirs'
	/** Write caller-supplied content, then stage it. */
	| 'custom'
	/** Keep the working-tree file as it stands (`git add`). */
	| 'keep'
	/** Resolve as deleted (`git rm`). */
	| 'delete'
	/** Put the conflict markers back (`git checkout --merge`). */
	| 'reset';

export interface GitConflictFile {
	path: string;
	/** Working-tree text. Empty when `contentOmitted` is true. */
	content: string;
	markers: GitConflictMarker[];
	kind: GitConflictKind;
	/** True when the file has no text side to edit (binary, missing, or oversized). */
	contentOmitted: boolean;
	/** Why the content was omitted — drives the resolver's fallback UI. */
	omitReason?: 'binary' | 'missing' | 'too-large';
	/** Working-tree size in bytes, when the file exists. */
	size?: number;
}

/**
 * Everything the UI needs to explain (and finish) an in-progress operation.
 *
 * `oursLabel`/`theirsLabel` exist because the two sides swap meaning between
 * merge and rebase: rebasing replays your commits onto the upstream, so `ours`
 * is the branch you are rebasing *onto* and `theirs` is your own commit — the
 * exact opposite of a merge. Showing the raw words without the branch names is
 * the single biggest source of wrong resolutions.
 */
export interface GitOperationState {
	operation: GitOperation | null;
	/** 1-based position in a multi-commit replay (rebase only). */
	step?: number;
	/** Total commits in the replay (rebase only). */
	total?: number;
	/** Human label for the `ours` side, e.g. "main". */
	oursLabel: string;
	/** Human label for the `theirs` side, e.g. "your commit". */
	theirsLabel: string;
	/** Subject of the commit being replayed, when there is one. */
	currentCommit?: string;
	/** Paths still unmerged. `--continue` is refused while this is non-zero. */
	unmergedCount: number;
	canContinue: boolean;
	canSkip: boolean;
	/**
	 * Unmerged paths with no operation sentinel — a `stash pop`/`apply` that hit
	 * a conflict. The stash entry survives a failed pop, so aborting here must
	 * say so rather than implying the work is gone.
	 */
	stashConflict: boolean;
}

// ============================================
// Push Target
// ============================================

/**
 * Where `git push` will actually send this branch.
 *
 * The panel used to push to whichever remote its dropdown had selected, with
 * `-u`. On a fork PR checked out for review that pushed the contributor's work
 * into the main repository as a new branch, and the `-u` rewrote the branch's
 * remote so every later push went there too. Resolving the real destination —
 * and showing it — is what keeps that from happening.
 */
export interface GitPushTarget {
	/** Remote name, or a bare URL when that is how the branch is configured. */
	remote: string;
	/** Branch name on the far side, which need not match the local name. */
	remoteBranch: string;
	/** False when the branch tracks nothing, so a push has to pick a destination. */
	hasUpstream: boolean;
	/** True when `remote` is a URL rather than a configured remote name. */
	isUrl: boolean;
	/** The local branch this was resolved for. */
	branch: string;
}

// ============================================
// Remote Types
// ============================================

export interface GitRemote {
	name: string;
	fetchUrl: string;
	pushUrl: string;
}

export interface GitRemoteStatus {
	ahead: number;
	behind: number;
	remote: string;
	branch: string;
}

// ============================================
// Stash Types
// ============================================

export interface GitStashEntry {
	index: number;
	message: string;
	date: string;
}

// ============================================
// Tag Types
// ============================================

export interface GitTag {
	name: string;
	hash: string;
	message: string;
	date: string;
	isAnnotated: boolean;
}

// ============================================
// Reflog
// ============================================

/**
 * One `git reflog` row. This is the repo's undo journal: it still holds commits
 * that branch deletes, resets and rebases have orphaned, so it is the only way
 * back from a destructive action.
 */
export interface GitReflogEntry {
	hash: string;
	hashShort: string;
	/** Reflog selector, e.g. `HEAD@{3}`. */
	selector: string;
	/** The recorded action, e.g. `rebase (finish)` or `commit`. */
	action: string;
	subject: string;
	date: string;
}

// ============================================
// Commit Message Generation
// ============================================

/** Format for AI-generated commit messages */
export type CommitMessageFormat = 'single-line' | 'multi-line';

/** Structured commit message output from AI */
export interface GeneratedCommitMessage {
	type: string;
	/** Null when no scope applies — strict-schema engines (Codex) require explicit null over omission. */
	scope: string | null;
	subject: string;
	/** Null for single-line commits — strict-schema engines (Codex) require explicit null over omission. */
	body: string | null;
}

/** Structured branch-name output from AI */
export interface GeneratedBranchName {
	description: string;
}

// ============================================
// Operation lock / sync types
// ============================================

/**
 * What a running git operation is doing, in the terms the panel's buttons use.
 * Each category drives one busy flag on the client, so a pull started anywhere
 * — another tab, another device — spins every Pull button that can see it.
 */
export type GitOpCategory =
	| 'commit'
	| 'staging'
	| 'push'
	| 'pull'
	| 'fetch'
	| 'more'
	| 'stash'
	| 'tag'
	| 'branch'
	| 'resolve'
	| 'configure';

/**
 * Which operations may overlap in one repository.
 *
 * - `exclusive` moves HEAD, the index or the working tree; it runs alone.
 * - `network` talks to a remote and only writes remote-tracking refs, so the
 *   index stays free for staging while a long push or fetch runs.
 * - `index` writes the index only (stage, unstage, discard).
 *
 * Two operations conflict when either is exclusive or both share a class.
 */
export type GitOpClass = 'exclusive' | 'network' | 'index';

export interface GitActiveOp {
	id: string;
	category: GitOpCategory;
	cls: GitOpClass;
	/** Human label, e.g. "Pull" or "Force push". */
	label: string;
	/** Branch, remote or tag the operation is aimed at, when it has one. */
	target?: string;
	startedAt: number;
}

/** Every operation running in one repository of one workspace. */
export interface GitRepoOpState {
	/** Workspace scope key (project, or project + worktree). */
	scope: string;
	/** Absolute path of a nested repo; absent for the workspace's own repo. */
	repoPath?: string;
	ops: GitActiveOp[];
}

/** How a pull reconciles local and remote history. */
export type GitPullMode = 'default' | 'merge' | 'rebase' | 'ff-only';

export interface GitPullResult {
	success: boolean;
	message: string;
	/**
	 * Why a pull did not complete, when git said something the panel can act on:
	 * `diverged` — both sides have commits and no reconcile strategy is set;
	 * `conflict` — the merge or rebase stopped on conflicts;
	 * `local-changes` — uncommitted work would be overwritten.
	 */
	reason?: 'diverged' | 'conflict' | 'local-changes';
	/** Local commits the remote does not have (set with `diverged`). */
	ahead?: number;
	/** Remote commits the local branch does not have (set with `diverged`). */
	behind?: number;
	/** Commits HEAD actually moved forward by, measured before and after. */
	pulledCount?: number;
}

export interface GitForcePullPreview {
	/** `<remote>/<branch>` or the URL-tracked equivalent the reset will land on. */
	target: string;
	/** Local commits that will no longer be on the branch. */
	localCommits: number;
	/** Remote commits that will arrive. */
	incomingCommits: number;
	/** Tracked files with uncommitted changes (they will be stashed). */
	changedFiles: number;
	/** Untracked files the remote tree would overwrite (they will be stashed). */
	collidingUntracked: string[];
}

export interface GitForcePullResult {
	previousHead: string;
	newHead: string;
	discardedCommits: number;
	/** Message of the safety stash, when one was created. */
	stashMessage?: string;
}

export interface GitPruneCandidate {
	name: string;
	/** Whether the branch is fully merged into the default branch. */
	merged: boolean;
}

export interface GitLockStatus {
	exists: boolean;
	/** Milliseconds since the lock file was last written. */
	ageMs: number;
	/** A git operation started by Clopen is still running in this project. */
	clopenOpRunning: boolean;
	/** Safe to offer removal: old enough and nothing of ours holds it. */
	removable: boolean;
}
