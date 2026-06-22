/**
 * Lightweight LCS-based line diff for the editor's git gutter.
 *
 * Produces hunks expressed in the *current* (right-side) line numbers so they
 * can be applied directly as Monaco line-decorations. Also exposes the
 * corresponding HEAD-side lines so the gutter can render an inline peek of the
 * original content when the user clicks a change marker.
 */

export interface GutterChange {
	type: 'added' | 'modified' | 'deleted';
	/** 1-based line number in the current content */
	startLine: number;
	/** 1-based inclusive end line number in the current content */
	endLine: number;
	/** 1-based start line in the HEAD content (0 if pure addition) */
	oldStartLine: number;
	/** 1-based inclusive end line in the HEAD content (0 if pure addition) */
	oldEndLine: number;
	/** Original lines from HEAD (empty for pure additions) */
	oldLines: string[];
	/** New lines in current content (empty for pure deletions) */
	newLines: string[];
}

/**
 * LCS is O(m*n) — bail on very large files to keep the editor responsive.
 * 8000 * 8000 cells * 4 bytes (Int32Array) = ~256 MB worst case, but typical
 * edited regions of a large file mean the full table rarely materializes at
 * the upper bound. The threshold covers the long tail of single-file Django
 * apps / generated modules without breaking the editor.
 */
const MAX_LINES = 8000;

function findLCS(a: string[], b: string[]): Int32Array[] {
	const m = a.length;
	const n = b.length;
	// Use a flat Int32Array per row to cut memory 4x vs number[][] (V8 stores
	// each sub-array as a heap object with overhead). For the upper bound
	// (20000^2 * 4 bytes) this is ~1.6 GB worst case, but the bail-out check
	// above keeps the realistic peak far below that.
	const dp: Int32Array[] = Array(m + 1);
	for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp;
}

type Op =
	| { type: 'keep'; newIdx: number; oldIdx: number }
	| { type: 'ins'; newIdx: number }
	| { type: 'del'; oldIdx: number };

export function computeLineDiff(headContent: string, currentContent: string): GutterChange[] {
	if (headContent === currentContent) return [];

	const oldLines = headContent.split('\n');
	const newLines = currentContent.split('\n');

	if (oldLines.length > MAX_LINES || newLines.length > MAX_LINES) return [];

	const dp = findLCS(oldLines, newLines);
	const ops: Op[] = [];
	let i = oldLines.length;
	let j = newLines.length;

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			ops.unshift({ type: 'keep', newIdx: j - 1, oldIdx: i - 1 });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.unshift({ type: 'ins', newIdx: j - 1 });
			j--;
		} else {
			ops.unshift({ type: 'del', oldIdx: i - 1 });
			i--;
		}
	}

	const changes: GutterChange[] = [];
	let k = 0;
	while (k < ops.length) {
		if (ops[k].type === 'keep') {
			k++;
			continue;
		}

		let insStart = -1;
		let insEnd = -1;
		let delStart = -1;
		let delEnd = -1;
		const hunkOldLines: string[] = [];
		const hunkNewLines: string[] = [];

		while (k < ops.length && ops[k].type !== 'keep') {
			const op = ops[k];
			if (op.type === 'del') {
				if (delStart === -1) delStart = op.oldIdx;
				delEnd = op.oldIdx;
				hunkOldLines.push(oldLines[op.oldIdx]);
			} else if (op.type === 'ins') {
				if (insStart === -1) insStart = op.newIdx;
				insEnd = op.newIdx;
				hunkNewLines.push(newLines[op.newIdx]);
			}
			k++;
		}

		const oldStartLine = delStart >= 0 ? delStart + 1 : 0;
		const oldEndLine = delEnd >= 0 ? delEnd + 1 : 0;

		if (insStart !== -1 && delStart !== -1) {
			changes.push({
				type: 'modified',
				startLine: insStart + 1,
				endLine: insEnd + 1,
				oldStartLine,
				oldEndLine,
				oldLines: hunkOldLines,
				newLines: hunkNewLines,
			});
		} else if (insStart !== -1) {
			changes.push({
				type: 'added',
				startLine: insStart + 1,
				endLine: insEnd + 1,
				oldStartLine: 0,
				oldEndLine: 0,
				oldLines: [],
				newLines: hunkNewLines,
			});
		} else {
			// Pure deletion — anchor the marker on the next surviving line, or
			// on the final line if the deletion is at the very end of the file.
			let markLine: number;
			if (k < ops.length) {
				const next = ops[k];
				markLine = next.type === 'keep' || next.type === 'ins' ? next.newIdx + 1 : newLines.length;
			} else {
				markLine = Math.max(newLines.length, 1);
			}
			changes.push({
				type: 'deleted',
				startLine: markLine,
				endLine: markLine,
				oldStartLine,
				oldEndLine,
				oldLines: hunkOldLines,
				newLines: [],
			});
		}
	}

	return changes;
}
