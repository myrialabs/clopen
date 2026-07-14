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

export interface GitConflictFile {
	path: string;
	content: string;
	markers: GitConflictMarker[];
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
