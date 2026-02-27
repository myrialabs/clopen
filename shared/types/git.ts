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
}

export interface GitBranchInfo {
	current: string;
	local: GitBranch[];
	remote: GitBranch[];
	ahead: number;
	behind: number;
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
