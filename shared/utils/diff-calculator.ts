/**
 * Diff Calculator Utility
 * Calculates git-like line-level differences between file contents
 * Accepts Buffer for binary-safe handling — converts to string internally for line diffing.
 */

export interface FileChangeStats {
	filesChanged: number;
	insertions: number;
	deletions: number;
}

export interface FileDiff {
	filepath: string;
	insertions: number;
	deletions: number;
	status: 'added' | 'modified' | 'deleted';
}

/**
 * Calculate line-level diff statistics similar to git
 * Compares two file snapshots and returns stats about changes
 */
export function calculateFileChangeStats(
	previousSnapshot: Record<string, Buffer>,
	currentSnapshot: Record<string, Buffer>
): FileChangeStats {
	let totalInsertions = 0;
	let totalDeletions = 0;
	const changedFiles = new Set<string>();

	// Check added and modified files
	for (const [filepath, newContent] of Object.entries(currentSnapshot)) {
		const oldContent = previousSnapshot[filepath];

		if (!oldContent) {
			// File was added - count all lines as insertions
			const lines = countLines(newContent.toString('utf-8'));
			totalInsertions += lines;
			changedFiles.add(filepath);
		} else if (!oldContent.equals(newContent)) {
			// File was modified - calculate line diff
			const diff = calculateLineDiff(oldContent.toString('utf-8'), newContent.toString('utf-8'));
			totalInsertions += diff.insertions;
			totalDeletions += diff.deletions;
			changedFiles.add(filepath);
		}
	}

	// Check deleted files
	for (const [filepath, oldContent] of Object.entries(previousSnapshot)) {
		if (!currentSnapshot[filepath]) {
			// File was deleted - count all lines as deletions
			const lines = countLines(oldContent.toString('utf-8'));
			totalDeletions += lines;
			changedFiles.add(filepath);
		}
	}

	return {
		filesChanged: changedFiles.size,
		insertions: totalInsertions,
		deletions: totalDeletions
	};
}

/**
 * Get detailed diff for each file
 * Useful for displaying individual file changes
 */
export function getDetailedFileDiffs(
	previousSnapshot: Record<string, Buffer>,
	currentSnapshot: Record<string, Buffer>
): FileDiff[] {
	const diffs: FileDiff[] = [];

	// Check added and modified files
	for (const [filepath, newContent] of Object.entries(currentSnapshot)) {
		const oldContent = previousSnapshot[filepath];

		if (!oldContent) {
			// File was added
			diffs.push({
				filepath,
				insertions: countLines(newContent.toString('utf-8')),
				deletions: 0,
				status: 'added'
			});
		} else if (!oldContent.equals(newContent)) {
			// File was modified
			const diff = calculateLineDiff(oldContent.toString('utf-8'), newContent.toString('utf-8'));
			diffs.push({
				filepath,
				insertions: diff.insertions,
				deletions: diff.deletions,
				status: 'modified'
			});
		}
	}

	// Check deleted files
	for (const [filepath, oldContent] of Object.entries(previousSnapshot)) {
		if (!currentSnapshot[filepath]) {
			// File was deleted
			diffs.push({
				filepath,
				insertions: 0,
				deletions: countLines(oldContent.toString('utf-8')),
				status: 'deleted'
			});
		}
	}

	return diffs;
}

/**
 * Calculate line-level diff between two file contents
 * Uses simple line-by-line comparison (similar to diff -u)
 */
function calculateLineDiff(
	oldContent: string,
	newContent: string
): { insertions: number; deletions: number } {
	const oldLines = splitLines(oldContent);
	const newLines = splitLines(newContent);

	// Use Myers diff algorithm (simplified version)
	// For performance, we use a simple LCS-based approach
	const lcs = longestCommonSubsequence(oldLines, newLines);

	const insertions = newLines.length - lcs;
	const deletions = oldLines.length - lcs;

	return { insertions, deletions };
}

/**
 * Calculate Longest Common Subsequence length
 * Used to determine how many lines are unchanged
 */
function longestCommonSubsequence(arr1: string[], arr2: string[]): number {
	const m = arr1.length;
	const n = arr2.length;

	// Create DP table
	const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));

	// Fill DP table
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (arr1[i - 1] === arr2[j - 1]) {
				dp[i][j] = dp[i - 1][j - 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
			}
		}
	}

	return dp[m][n];
}

/**
 * Split content into lines
 * Handles different line endings (CRLF, LF)
 */
function splitLines(content: string): string[] {
	if (!content) return [];
	// Normalize line endings and split
	return content.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Count number of lines in content
 */
function countLines(content: string): number {
	if (!content) return 0;
	const lines = splitLines(content);
	// Don't count empty last line
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		return lines.length - 1;
	}
	return lines.length;
}
