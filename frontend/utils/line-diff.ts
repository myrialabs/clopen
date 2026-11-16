/**
 * Line diff for the editor's change gutter (git HEAD vs buffer, and AI edits).
 *
 * Produces hunks expressed in the *current* (right-side) line numbers so they
 * can be applied directly as Monaco line-decorations. Also exposes the
 * corresponding HEAD-side lines so the gutter can render an inline peek of the
 * original content when the user clicks a change marker.
 *
 * The edit script comes from the shared engine in
 * `$shared/utils/diff-calculator` — the same exact diff that produces every
 * +/- count in the app, so the gutter marks precisely the lines the Changes
 * tab counts. Its cost follows the size of the change, not of the file, and its
 * memory is linear, which is what lets it run on the main thread on every
 * buffer sync. A changed file always yields at least one hunk.
 */

import { diffSequences, type DiffOp } from '$shared/utils/diff-calculator';

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
	/**
	 * False when the hunk was carried over from another revision and its lines
	 * have shifted or partly gone since (see line-map.ts). Undefined means the
	 * hunk was computed against the buffer it decorates, so the question does
	 * not arise.
	 */
	exact?: boolean;
	/** Which AI edit this hunk belongs to (undefined for git gutters) */
	editIndex?: number;
	/** Timestamp of the AI edit (undefined for git gutters) */
	timestamp?: number;
}

interface RawHunk {
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
}

function opsToHunks(ops: DiffOp[]): RawHunk[] {
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
		if (op.type === 'delete') {
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

	const hunks = slideHunksDown(opsToHunks(diffSequences(oldLines, newLines)), oldLines, newLines);
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
