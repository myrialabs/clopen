/**
 * Line diff for the editor's change gutter (git HEAD vs buffer, and AI edits).
 *
 * Produces hunks expressed in the *current* (right-side) line numbers so they
 * can be applied directly as Monaco line-decorations. Also exposes the
 * corresponding HEAD-side lines so the gutter can render an inline peek of the
 * original content when the user clicks a change marker.
 *
 * The diff runs on the main thread on every buffer sync, so it is built to keep
 * three guarantees no matter what it is handed:
 *
 *   1. bounded time     — no input makes it slower than a few tens of ms
 *   2. bounded memory    — no input makes it allocate more than tens of MB
 *   3. never silently empty — if the two sides differ, at least one hunk comes
 *      back, so a changed file can never render an unmarked gutter
 *
 * The third guarantee is why this is not a plain LCS. A full LCS table costs
 * O(m*n) in both time and memory, so it can only be used behind a line-count
 * cap — and past that cap it returns nothing, leaving a modified file looking
 * untouched. Instead the work is reduced before any expensive step runs:
 * common prefix/suffix are trimmed, the remainder is split on lines that occur
 * exactly once on both sides (patience anchoring), and only the small segments
 * between those anchors are diffed exactly with Myers. A segment that is both
 * anchorless and larger than the edit budget degrades to a coarse hunk rather
 * than to nothing — it may over-report, never under-report.
 */

export interface GutterChange {
	type: 'added' | 'modified' | 'deleted';
	/** 1-based line number in the current content */
	startLine: number;
	/** 1-based inclusive end line number in the current content */
	endLine: number;
	/** 1-based start line in the HEAD content (0 if pure addition) */
	oldStartLine: number;
	/** 1-based inclusive end line number in the HEAD content (0 if pure addition) */
	oldEndLine: number;
	/** Original lines from HEAD (empty for pure additions) */
	oldLines: string[];
	/** New lines in current content (empty for pure deletions) */
	newLines: string[];
	/** Which AI edit this hunk belongs to (undefined for git gutters) */
	editIndex?: number;
	/** Timestamp of the AI edit (undefined for git gutters) */
	timestamp?: number;
}

type Op =
	| { type: 'keep'; newIdx: number; oldIdx: number }
	| { type: 'ins'; newIdx: number }
	| { type: 'del'; oldIdx: number };

/**
 * Largest edit distance Myers may explore before a segment degrades to a coarse
 * hunk. Myers keeps one frontier snapshot per step, so its memory grows as
 * D^2 * 4 bytes: 2000 caps that at ~16 MB, which measures as a ~20 MB peak.
 * Raising it buys very little — patience anchoring already keeps real segments
 * far below the budget — while the memory ceiling grows quadratically.
 */
const MAX_EDIT_DISTANCE = 2000;

/** Guards the anchor recursion against inputs that keep splitting into slivers. */
const MAX_ANCHOR_DEPTH = 12;

/**
 * Myers' greedy O(ND) diff over a segment, or null when reaching the end would
 * cost more than `maxD` edit steps.
 */
function myersOps(a: string[], b: string[], maxD: number): Op[] | null {
	const n = a.length;
	const m = b.length;
	const max = n + m;
	if (max === 0) return [];

	const offset = max;
	const v = new Int32Array(2 * max + 1);
	const trace: Int32Array[] = [];
	const limit = Math.min(max, maxD);

	for (let d = 0; d <= limit; d++) {
		// Snapshot the frontier as it stands *before* step d, clamped to the band
		// of diagonals step d is able to read (k in [-d, d]).
		trace.push(v.slice(offset - d, offset + d + 1));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
			else x = v[offset + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) return backtrack(trace, d, n, m);
		}
	}
	return null;
}

/** Walk the recorded frontiers back from (n, m) to (0, 0) to recover the edits. */
function backtrack(trace: Int32Array[], d: number, n: number, m: number): Op[] {
	const ops: Op[] = [];
	let x = n;
	let y = m;

	for (let step = d; step > 0; step--) {
		// trace[step] is the frontier before step `step`, indexed with offset `step`.
		const prev = trace[step];
		const k = x - y;
		const down = k === -step || (k !== step && prev[k - 1 + step] < prev[k + 1 + step]);
		const prevK = down ? k + 1 : k - 1;
		const prevX = prev[prevK + step];
		const prevY = prevX - prevK;

		while (x > prevX && y > prevY) ops.unshift({ type: 'keep', newIdx: --y, oldIdx: --x });
		if (down) ops.unshift({ type: 'ins', newIdx: --y });
		else ops.unshift({ type: 'del', oldIdx: --x });

		x = prevX;
		y = prevY;
	}

	while (x > 0 && y > 0) ops.unshift({ type: 'keep', newIdx: --y, oldIdx: --x });
	while (y > 0) ops.unshift({ type: 'ins', newIdx: --y });
	while (x > 0) ops.unshift({ type: 'del', oldIdx: --x });
	return ops;
}

/** Length of the shared prefix and suffix, the cheapest possible reduction. */
function measureCommonEnds(a: string[], b: string[]) {
	const max = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < max && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	return { prefix, suffix };
}

/**
 * Lines occurring exactly once on both sides, paired up and reduced to a
 * non-crossing subsequence. These are the patience-diff anchors: matching on
 * them splits one large diff into several small independent ones.
 */
function uniqueCommonAnchors(a: string[], b: string[]): Array<[number, number]> {
	const countA = new Map<string, number>();
	const indexA = new Map<string, number>();
	for (let i = 0; i < a.length; i++) {
		countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
		indexA.set(a[i], i);
	}
	const countB = new Map<string, number>();
	const indexB = new Map<string, number>();
	for (let j = 0; j < b.length; j++) {
		countB.set(b[j], (countB.get(b[j]) ?? 0) + 1);
		indexB.set(b[j], j);
	}

	const pairs: Array<[number, number]> = [];
	for (const [line, n] of countA) {
		if (n === 1 && countB.get(line) === 1) pairs.push([indexA.get(line)!, indexB.get(line)!]);
	}
	if (pairs.length === 0) return pairs;
	pairs.sort((p, q) => p[0] - q[0]);

	// Longest increasing subsequence on the b-side index; anchors that cross each
	// other cannot both be kept without reordering the file.
	const tails: number[] = [];
	const tailIdx: number[] = [];
	const prev = new Array<number>(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		const value = pairs[k][1];
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (tails[mid] < value) lo = mid + 1;
			else hi = mid;
		}
		tails[lo] = value;
		tailIdx[lo] = k;
		prev[k] = lo > 0 ? tailIdx[lo - 1] : -1;
	}

	const anchors: Array<[number, number]> = [];
	let k = tails.length > 0 ? tailIdx[tails.length - 1] : -1;
	while (k >= 0) {
		anchors.unshift(pairs[k]);
		k = prev[k];
	}
	return anchors;
}

/** Build the edit script for two whole files. */
function diffOps(a: string[], b: string[]): Op[] {
	const ops: Op[] = [];

	const walk = (
		aSeg: string[],
		bSeg: string[],
		aOffset: number,
		bOffset: number,
		depth: number
	): void => {
		if (aSeg.length === 0 && bSeg.length === 0) return;
		if (aSeg.length === 0) {
			for (let j = 0; j < bSeg.length; j++) ops.push({ type: 'ins', newIdx: bOffset + j });
			return;
		}
		if (bSeg.length === 0) {
			for (let i = 0; i < aSeg.length; i++) ops.push({ type: 'del', oldIdx: aOffset + i });
			return;
		}

		const { prefix, suffix } = measureCommonEnds(aSeg, bSeg);
		for (let p = 0; p < prefix; p++) {
			ops.push({ type: 'keep', newIdx: bOffset + p, oldIdx: aOffset + p });
		}

		const aMid = aSeg.slice(prefix, aSeg.length - suffix);
		const bMid = bSeg.slice(prefix, bSeg.length - suffix);
		const aMidOffset = aOffset + prefix;
		const bMidOffset = bOffset + prefix;

		const emitSuffix = () => {
			for (let s = 0; s < suffix; s++) {
				ops.push({
					type: 'keep',
					newIdx: bOffset + bSeg.length - suffix + s,
					oldIdx: aOffset + aSeg.length - suffix + s
				});
			}
		};

		if (aMid.length === 0 && bMid.length === 0) {
			emitSuffix();
			return;
		}

		// Small enough to solve exactly.
		if (Math.min(aMid.length, bMid.length) <= MAX_EDIT_DISTANCE) {
			const exact = myersOps(aMid, bMid, MAX_EDIT_DISTANCE);
			if (exact) {
				for (const op of exact) {
					if (op.type === 'keep') {
						ops.push({ type: 'keep', newIdx: bMidOffset + op.newIdx, oldIdx: aMidOffset + op.oldIdx });
					} else if (op.type === 'ins') {
						ops.push({ type: 'ins', newIdx: bMidOffset + op.newIdx });
					} else {
						ops.push({ type: 'del', oldIdx: aMidOffset + op.oldIdx });
					}
				}
				emitSuffix();
				return;
			}
		}

		// Too big to solve directly — split on unique lines and recurse.
		const anchors = depth < MAX_ANCHOR_DEPTH ? uniqueCommonAnchors(aMid, bMid) : [];
		if (anchors.length > 0) {
			let ai = 0;
			let bi = 0;
			for (const [aIdx, bIdx] of anchors) {
				walk(aMid.slice(ai, aIdx), bMid.slice(bi, bIdx), aMidOffset + ai, bMidOffset + bi, depth + 1);
				ops.push({ type: 'keep', newIdx: bMidOffset + bIdx, oldIdx: aMidOffset + aIdx });
				ai = aIdx + 1;
				bi = bIdx + 1;
			}
			walk(aMid.slice(ai), bMid.slice(bi), aMidOffset + ai, bMidOffset + bi, depth + 1);
			emitSuffix();
			return;
		}

		// Anchorless and over budget. Equal lengths mean the region is a pure
		// substitution, which lines up exactly for the cost of one scan; otherwise
		// report the whole region as changed rather than reporting nothing.
		if (aMid.length === bMid.length) {
			for (let i = 0; i < aMid.length; i++) {
				if (aMid[i] === bMid[i]) {
					ops.push({ type: 'keep', newIdx: bMidOffset + i, oldIdx: aMidOffset + i });
				} else {
					ops.push({ type: 'del', oldIdx: aMidOffset + i });
					ops.push({ type: 'ins', newIdx: bMidOffset + i });
				}
			}
		} else {
			for (let i = 0; i < aMid.length; i++) ops.push({ type: 'del', oldIdx: aMidOffset + i });
			for (let j = 0; j < bMid.length; j++) ops.push({ type: 'ins', newIdx: bMidOffset + j });
		}
		emitSuffix();
	};

	walk(a, b, 0, 0, 0);
	return ops;
}

interface RawHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

function opsToHunks(ops: Op[]): RawHunk[] {
	const hunks: RawHunk[] = [];
	let oldIdx = 0;
	let newIdx = 0;
	let current: RawHunk | null = null;

	for (const op of ops) {
		if (op.type === 'keep') {
			current = null;
			oldIdx++;
			newIdx++;
			continue;
		}
		if (!current) {
			current = { oldStart: oldIdx, oldCount: 0, newStart: newIdx, newCount: 0 };
			hunks.push(current);
		}
		if (op.type === 'del') {
			current.oldCount++;
			oldIdx++;
		} else {
			current.newCount++;
			newIdx++;
		}
	}
	return hunks;
}

/**
 * Push pure insertions/deletions as far down as identical surrounding lines
 * allow. Several diffs of the same edit can be equally minimal — appending to a
 * list of identical lines can be read as touching the first or the last of them
 * — so settling on one canonical position keeps the gutter from jumping around
 * as the user types, and matches where git reports the same hunk.
 */
function slideHunksDown(hunks: RawHunk[], oldLines: string[], newLines: string[]): RawHunk[] {
	return hunks.map((hunk) => {
		const slid = { ...hunk };
		if (slid.oldCount === 0 && slid.newCount > 0) {
			while (
				slid.newStart + slid.newCount < newLines.length &&
				newLines[slid.newStart] === newLines[slid.newStart + slid.newCount] &&
				oldLines[slid.oldStart] === newLines[slid.newStart]
			) {
				slid.newStart++;
				slid.oldStart++;
			}
		} else if (slid.newCount === 0 && slid.oldCount > 0) {
			while (
				slid.oldStart + slid.oldCount < oldLines.length &&
				oldLines[slid.oldStart] === oldLines[slid.oldStart + slid.oldCount] &&
				newLines[slid.newStart] === oldLines[slid.oldStart]
			) {
				slid.oldStart++;
				slid.newStart++;
			}
		}
		return slid;
	});
}

export function computeLineDiff(headContent: string, currentContent: string): GutterChange[] {
	if (headContent === currentContent) return [];

	const oldLines = headContent.split('\n');
	const newLines = currentContent.split('\n');

	const hunks = slideHunksDown(opsToHunks(diffOps(oldLines, newLines)), oldLines, newLines);
	const changes: GutterChange[] = [];

	for (const hunk of hunks) {
		const hunkOldLines = oldLines.slice(hunk.oldStart, hunk.oldStart + hunk.oldCount);
		const hunkNewLines = newLines.slice(hunk.newStart, hunk.newStart + hunk.newCount);
		const oldStartLine = hunk.oldCount > 0 ? hunk.oldStart + 1 : 0;
		const oldEndLine = hunk.oldCount > 0 ? hunk.oldStart + hunk.oldCount : 0;

		if (hunk.newCount > 0 && hunk.oldCount > 0) {
			changes.push({
				type: 'modified',
				startLine: hunk.newStart + 1,
				endLine: hunk.newStart + hunk.newCount,
				oldStartLine,
				oldEndLine,
				oldLines: hunkOldLines,
				newLines: hunkNewLines
			});
		} else if (hunk.newCount > 0) {
			changes.push({
				type: 'added',
				startLine: hunk.newStart + 1,
				endLine: hunk.newStart + hunk.newCount,
				oldStartLine: 0,
				oldEndLine: 0,
				oldLines: [],
				newLines: hunkNewLines
			});
		} else {
			// Pure deletion — anchor the marker on the next surviving line, or on
			// the final line if the deletion is at the very end of the file.
			const markLine = Math.min(Math.max(hunk.newStart + 1, 1), Math.max(newLines.length, 1));
			changes.push({
				type: 'deleted',
				startLine: markLine,
				endLine: markLine,
				oldStartLine,
				oldEndLine,
				oldLines: hunkOldLines,
				newLines: []
			});
		}
	}

	return changes;
}
