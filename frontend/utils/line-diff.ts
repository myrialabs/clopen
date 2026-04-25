/**
 * Lightweight LCS-based line diff for the editor's git gutter.
 *
 * Produces hunks expressed in the *current* (right-side) line numbers so they
 * can be applied directly as Monaco line-decorations.
 */

export interface GutterChange {
	type: 'added' | 'modified' | 'deleted';
	/** 1-based line number in the current content */
	startLine: number;
	/** 1-based inclusive end line number in the current content */
	endLine: number;
}

/**
 * LCS is O(m*n) — bail on very large files to keep the editor responsive.
 * 4000 * 4000 * 4 bytes ≈ 64MB peak; well below browser limits but still
 * comfortably fast (~100ms on modern hardware).
 */
const MAX_LINES = 4000;

function findLCS(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array(m + 1)
		.fill(null)
		.map(() => Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return dp;
}

type Op =
	| { type: 'keep'; newIdx: number }
	| { type: 'ins'; newIdx: number }
	| { type: 'del' };

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
			ops.unshift({ type: 'keep', newIdx: j - 1 });
			i--;
			j--;
		} else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
			ops.unshift({ type: 'ins', newIdx: j - 1 });
			j--;
		} else {
			ops.unshift({ type: 'del' });
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

		let dels = 0;
		let insStart = -1;
		let insEnd = -1;
		while (k < ops.length && ops[k].type !== 'keep') {
			const op = ops[k];
			if (op.type === 'del') {
				dels++;
			} else if (op.type === 'ins') {
				if (insStart === -1) insStart = op.newIdx;
				insEnd = op.newIdx;
			}
			k++;
		}

		if (insStart !== -1 && dels > 0) {
			changes.push({ type: 'modified', startLine: insStart + 1, endLine: insEnd + 1 });
		} else if (insStart !== -1) {
			changes.push({ type: 'added', startLine: insStart + 1, endLine: insEnd + 1 });
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
			changes.push({ type: 'deleted', startLine: markLine, endLine: markLine });
		}
	}

	return changes;
}
