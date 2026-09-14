/**
 * Diff Calculator Utility
 * Calculates git-like line-level differences between file contents
 * Accepts Buffer for binary-safe handling — converts to string internally for line diffing.
 *
 * "Binary-safe" means binary files are not line-counted at all. Splitting a PNG
 * on newline bytes yields a line count with no meaning, and two screenshots
 * once reported +159 lines into a checkpoint's total — dwarfing the source
 * changes the number was there to describe.
 */

export interface FileChangeStats {
	filesChanged: number;
	insertions: number;
	deletions: number;
}

/**
 * Whether these bytes are binary, and so cannot be counted or diffed as lines.
 * A NUL byte in the first few KB is the same heuristic git uses.
 */
export function isBinaryBuffer(buf: Buffer): boolean {
	const limit = Math.min(buf.length, 8000);
	for (let i = 0; i < limit; i++) {
		if (buf[i] === 0) return true;
	}
	return false;
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

	// Check added and modified files. A binary file still counts as changed — it
	// just contributes no lines, because it has none.
	for (const [filepath, newContent] of Object.entries(currentSnapshot)) {
		const oldContent = previousSnapshot[filepath];

		if (!oldContent) {
			changedFiles.add(filepath);
			if (isBinaryBuffer(newContent)) continue;
			totalInsertions += countLines(newContent.toString('utf-8'));
		} else if (!oldContent.equals(newContent)) {
			changedFiles.add(filepath);
			if (isBinaryBuffer(newContent) || isBinaryBuffer(oldContent)) continue;
			const diff = calculateLineDiff(oldContent.toString('utf-8'), newContent.toString('utf-8'));
			totalInsertions += diff.insertions;
			totalDeletions += diff.deletions;
		}
	}

	// Check deleted files
	for (const [filepath, oldContent] of Object.entries(previousSnapshot)) {
		if (!currentSnapshot[filepath]) {
			changedFiles.add(filepath);
			if (isBinaryBuffer(oldContent)) continue;
			totalDeletions += countLines(oldContent.toString('utf-8'));
		}
	}

	return {
		filesChanged: changedFiles.size,
		insertions: totalInsertions,
		deletions: totalDeletions
	};
}

/**
 * Count only the lines that actually changed between two strings, using the
 * same LCS-based diff as git — identical (context) lines are excluded. Use this
 * for +/- badges instead of naively counting every line of each side.
 */
export function countLineChanges(
	oldContent: string,
	newContent: string
): { additions: number; deletions: number } {
	const { insertions, deletions } = calculateLineDiff(oldContent, newContent);
	return { additions: insertions, deletions };
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
	const lines = content.replace(/\r\n/g, '\n').split('\n');
	// A trailing newline terminates the last line, it does not open a new one.
	// Counting the empty string it leaves behind inflated every added or deleted
	// file by exactly one line — a 2-line new file was reported as +3, which is
	// not what git says and not what the user counts in the editor.
	if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
	return lines;
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
