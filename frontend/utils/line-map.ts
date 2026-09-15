/**
 * Carrying a hunk from the revision it was computed against onto the one now on
 * screen.
 *
 * The AI gutter answers "what did THIS turn change". That question has to be
 * asked of the turn's own before/after pair — asking it of the current buffer
 * folds every later turn into the answer, which is how turn 2 ended up painting
 * turn 3 and 4's work as its own.
 *
 * But the gutter decorates the buffer, and the turn's "after" is not the buffer:
 * later turns and the user's own edits have moved lines since. So the hunks are
 * computed in the turn's coordinates and then translated here, using the diff
 * between that revision and the buffer as the dictionary.
 *
 * A line that no longer exists cannot be decorated, so its hunk is dropped. That
 * is the honest answer for a gutter: it marks what is there, not what was.
 */

import type { GutterChange } from './line-diff';

/** Where a line of the older revision sits now, or null when it is gone. */
export type LineMap = (line: number) => number | null;

interface Segment {
	/** 1-based first line of the run in the older revision. */
	oldStart: number;
	/** 1-based first line of the same run in the newer revision. */
	newStart: number;
	/** How many lines run 1:1, or Infinity for the tail after the last hunk. */
	length: number;
}

/** Lines a hunk covers on each side, read back from the coordinates it carries. */
function hunkCounts(hunk: GutterChange): { oldCount: number; newCount: number } {
	return {
		oldCount: hunk.oldStartLine > 0 ? hunk.oldEndLine - hunk.oldStartLine + 1 : 0,
		newCount: hunk.type === 'deleted' ? 0 : hunk.endLine - hunk.startLine + 1
	};
}

/**
 * Build the translation from an older revision's line numbers to a newer one's,
 * out of the hunks between them (`computeLineDiff(older, newer)`).
 *
 * Everything the diff did not touch runs 1:1, shifted by whatever the hunks
 * before it inserted or removed; everything a hunk covers on the old side is
 * either gone or rewritten, and maps to nothing.
 */
export function buildLineMap(hunks: GutterChange[]): LineMap {
	const segments: Segment[] = [];
	let oldPos = 1;
	let newPos = 1;

	for (const hunk of hunks) {
		const { oldCount, newCount } = hunkCounts(hunk);
		// A hunk with an old side knows exactly where it starts there. A pure
		// addition does not, but everything before it is 1:1, so its position in
		// the new revision measures the same gap.
		const gap = Math.max(
			0,
			oldCount > 0 ? hunk.oldStartLine - oldPos : hunk.startLine - newPos
		);

		if (gap > 0) segments.push({ oldStart: oldPos, newStart: newPos, length: gap });
		oldPos += gap + oldCount;
		newPos += gap + newCount;
	}

	segments.push({ oldStart: oldPos, newStart: newPos, length: Infinity });

	return (line: number): number | null => {
		if (line < 1) return null;
		for (const segment of segments) {
			if (line < segment.oldStart) return null;
			if (line < segment.oldStart + segment.length) {
				return segment.newStart + (line - segment.oldStart);
			}
		}
		return null;
	};
}

/**
 * Move hunks onto the newer revision's line numbers, dropping any whose lines
 * are no longer there.
 *
 * `exact` records whether every line of the hunk survived unmoved relative to
 * its neighbours. Only an exact hunk may be discarded: reverting a range that
 * has since been partly rewritten would take a later change down with it.
 */
export function remapHunks(hunks: GutterChange[], map: LineMap): GutterChange[] {
	const remapped: GutterChange[] = [];

	for (const hunk of hunks) {
		if (hunk.type === 'deleted') {
			// The marker sits on a surviving line, not on the removed ones.
			const anchor = map(hunk.startLine);
			if (anchor === null) continue;
			remapped.push({ ...hunk, startLine: anchor, endLine: anchor, exact: true });
			continue;
		}

		let first: number | null = null;
		let last: number | null = null;
		let survivors = 0;
		for (let line = hunk.startLine; line <= hunk.endLine; line++) {
			const mapped = map(line);
			if (mapped === null) continue;
			survivors++;
			if (first === null) first = mapped;
			last = mapped;
		}

		if (first === null || last === null) continue;

		const span = last - first + 1;
		const original = hunk.endLine - hunk.startLine + 1;
		remapped.push({
			...hunk,
			startLine: first,
			endLine: last,
			exact: survivors === original && span === original
		});
	}

	return remapped;
}
