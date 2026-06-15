/**
 * Line-level diff utility (LCS-based).
 *
 * Two outputs:
 *  - `buildGitFileDiff()`: full GitFileDiff with 3 lines of context (standard
 *    `git diff` shape). Use this to feed the existing Monaco diff path.
 *  - `computeLineDiff()`: compact hunks with ONLY + and - lines (no context).
 *    Kept as a utility for future use.
 */

import type { GitFileDiff, GitDiffHunk, GitDiffLine } from '$shared/types/git';

type Op = { op: '=' | '+' | '-'; oldIdx: number; newIdx: number };

/**
 * Run LCS between two line arrays and return the full edit script.
 */
function computeOps(oldLines: string[], newLines: string[]): Op[] {
	const m = oldLines.length;
	const n = newLines.length;
	const dp: Uint32Array[] = new Array(m + 1);
	for (let i = 0; i <= m; i++) dp[i] = new Uint32Array(n + 1);

	for (let i = 1; i <= m; i++) {
		const a = oldLines[i - 1];
		const row = dp[i];
		const prev = dp[i - 1];
		for (let j = 1; j <= n; j++) {
			if (a === newLines[j - 1]) {
				row[j] = prev[j - 1] + 1;
			} else {
				row[j] = prev[j] >= row[j - 1] ? prev[j] : row[j - 1];
			}
		}
	}

	const ops: Op[] = [];
	let i = m;
	let j = n;
	while (i > 0 && j > 0) {
		if (oldLines[i - 1] === newLines[j - 1]) {
			ops.push({ op: '=', oldIdx: i - 1, newIdx: j - 1 });
			i--;
			j--;
		} else if (dp[i - 1][j] >= dp[i][j - 1]) {
			ops.push({ op: '-', oldIdx: i - 1, newIdx: -1 });
			i--;
		} else {
			ops.push({ op: '+', oldIdx: -1, newIdx: j - 1 });
			j--;
		}
	}
	while (i > 0) {
		ops.push({ op: '-', oldIdx: i - 1, newIdx: -1 });
		i--;
	}
	while (j > 0) {
		ops.push({ op: '+', oldIdx: -1, newIdx: j - 1 });
		j--;
	}
	ops.reverse();
	return ops;
}

export type DiffLineType = 'add' | 'delete';

export interface DiffLine {
	type: DiffLineType;
	content: string;
	oldLineNumber?: number;
	newLineNumber?: number;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

/**
 * Compact hunks with ONLY `+` / `-` lines (no context).
 */
export function computeLineDiff(oldContent: string, newContent: string): DiffHunk[] {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	const ops = computeOps(oldLines, newLines);

	const hunks: DiffHunk[] = [];
	let buf: DiffLine[] = [];
	let oldCount = 0;
	let newCount = 0;
	let hunkOpen = false;
	let minOld = Number.POSITIVE_INFINITY;
	let minNew = Number.POSITIVE_INFINITY;

	const flush = () => {
		if (!hunkOpen || buf.length === 0) {
			buf = [];
			hunkOpen = false;
			oldCount = 0;
			newCount = 0;
			minOld = Number.POSITIVE_INFINITY;
			minNew = Number.POSITIVE_INFINITY;
			return;
		}
		const oStart = minOld === Number.POSITIVE_INFINITY ? 1 : minOld;
		const nStart = minNew === Number.POSITIVE_INFINITY ? oStart : minNew;
		hunks.push({ oldStart: oStart, oldLines: oldCount, newStart: nStart, newLines: newCount, lines: buf });
		buf = [];
		hunkOpen = false;
		oldCount = 0;
		newCount = 0;
		minOld = Number.POSITIVE_INFINITY;
		minNew = Number.POSITIVE_INFINITY;
	};

	for (const op of ops) {
		if (op.op === '=') continue;
		if (!hunkOpen) hunkOpen = true;
		if (op.op === '-') {
			buf.push({ type: 'delete', content: oldLines[op.oldIdx], oldLineNumber: op.oldIdx + 1 });
			oldCount++;
			if (op.oldIdx + 1 < minOld) minOld = op.oldIdx + 1;
		} else {
			buf.push({ type: 'add', content: newLines[op.newIdx], newLineNumber: op.newIdx + 1 });
			newCount++;
			if (op.newIdx + 1 < minNew) minNew = op.newIdx + 1;
		}
	}
	flush();

	return hunks;
}

/**
 * Build a full GitFileDiff with hunks containing 3 lines of context on either
 * side of each change. Consecutive change groups separated by ≤ 6 unchanged
 * lines are merged into a single hunk (matches `git diff` default behaviour).
 */
export function buildGitFileDiff(
	oldContent: string,
	newContent: string,
	filepath: string,
	status: string = 'M'
): GitFileDiff {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');
	const ops = computeOps(oldLines, newLines);

	const CONTEXT = 3;
	const MERGE_GAP = CONTEXT * 2;
	const hunks: GitDiffHunk[] = [];

	let i = 0;
	while (i < ops.length) {
		if (ops[i].op === '=') {
			i++;
			continue;
		}

		// Start of hunk: walk back up to CONTEXT '=' lines
		let start = i;
		let back = 0;
		while (start > 0 && ops[start - 1].op === '=' && back < CONTEXT) {
			start--;
			back++;
		}

		// End: extend through changes, merging close groups
		let end = i;
		while (end < ops.length) {
			if (ops[end].op !== '=') {
				end++;
				continue;
			}
			// Hit '=' — look for next change
			let next = end + 1;
			while (next < ops.length && ops[next].op === '=') next++;
			if (next >= ops.length) {
				// Trailing context — include if ≤ CONTEXT
				if (ops.length - end <= CONTEXT) end = ops.length;
				break;
			}
			if (next - end <= MERGE_GAP) {
				end = next; // merge
			} else {
				break;
			}
		}
		// Extend end by CONTEXT '='
		let fwd = 0;
		while (end < ops.length && ops[end].op === '=' && fwd < CONTEXT) {
			end++;
			fwd++;
		}

		// Build hunk lines
		const lines: GitDiffLine[] = [];
		let oldStart = 0;
		let newStart = 0;
		for (let j = start; j < end; j++) {
			const op = ops[j];
			if (op.op === '=') {
				if (oldStart === 0) {
					oldStart = op.oldIdx + 1;
					newStart = op.newIdx + 1;
				}
				lines.push({
					type: 'context',
					content: oldLines[op.oldIdx],
					oldLineNumber: op.oldIdx + 1,
					newLineNumber: op.newIdx + 1
				});
			} else if (op.op === '-') {
				if (oldStart === 0) {
					oldStart = op.oldIdx + 1;
					newStart = op.oldIdx + 1;
				}
				lines.push({
					type: 'delete',
					content: oldLines[op.oldIdx],
					oldLineNumber: op.oldIdx + 1
				});
			} else {
				if (oldStart === 0) {
					oldStart = newStart || 1;
				}
				if (newStart === 0) newStart = op.newIdx + 1;
				lines.push({
					type: 'add',
					content: newLines[op.newIdx],
					newLineNumber: op.newIdx + 1
				});
			}
		}

		// Tally counts
		let oldCount = 0;
		let newCount = 0;
		for (const l of lines) {
			if (l.type === 'context' || l.type === 'delete') oldCount++;
			if (l.type === 'context' || l.type === 'add') newCount++;
		}

		hunks.push({
			oldStart: oldStart || 1,
			oldLines: oldCount,
			newStart: newStart || 1,
			newLines: newCount,
			header: '',
			lines
		});

		i = end;
	}

	return {
		oldPath: filepath,
		newPath: filepath,
		status,
		hunks,
		isBinary: false
	};
}
