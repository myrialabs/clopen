/**
 * The model behind a rendered diff block (tool Edit/Write rows, restore and
 * worktree conflict previews): which lines stayed, went and arrived, and —
 * for paired changed lines — which characters moved.
 *
 * Pure and synchronous on purpose: it runs inside the diff worker
 * (`frontend/services/diff`), never on the UI thread, because the conflict
 * modals hand it whole files. Every comparison goes through the shared engine
 * in `$shared/utils/diff-calculator`, so a block shows exactly the changes the
 * +/- counts describe.
 */

import { removeCommonIndentationFromTwoSides } from '$frontend/components/chat/shared/utils';
import { countCommon, diffSequences } from '$shared/utils/diff-calculator';

export interface DiffRange {
	start: number;
	end: number;
}

export interface DiffBlockRow {
	type: 'unchanged' | 'removed' | 'added';
	content: string;
	/** Character ranges that changed within a paired line (classic blocks only). */
	highlights?: DiffRange[];
}

/** Paired lines this similar or more get character-level highlights. */
const HIGHLIGHT_SIMILARITY = 0.3;

/**
 * All rows of the block in display order: unchanged lines as they come, and
 * within each changed region every removed line before every added one.
 */
export function computeDiffBlock(
	oldString: string,
	newString: string,
	options: { highlights: boolean }
): DiffBlockRow[] {
	const { oldLines, newLines } = removeCommonIndentationFromTwoSides(
		oldString.split('\n'),
		newString.split('\n')
	);

	const rows: DiffBlockRow[] = [];
	let removed: DiffBlockRow[] = [];
	let added: DiffBlockRow[] = [];

	const flushChange = () => {
		if (removed.length === 0 && added.length === 0) return;
		if (options.highlights) highlightPairs(removed, added);
		rows.push(...removed, ...added);
		removed = [];
		added = [];
	};

	for (const op of diffSequences(oldLines, newLines)) {
		if (op.type === 'keep') {
			flushChange();
			rows.push({ type: 'unchanged', content: oldLines[op.oldIndex] });
		} else if (op.type === 'delete') {
			removed.push({ type: 'removed', content: oldLines[op.oldIndex] });
		} else {
			added.push({ type: 'added', content: newLines[op.newIndex] });
		}
	}
	flushChange();

	return rows;
}

/** Pair the n-th removed line with the n-th added one and mark what moved. */
function highlightPairs(removed: DiffBlockRow[], added: DiffBlockRow[]): void {
	const pairs = Math.min(removed.length, added.length);
	for (let idx = 0; idx < pairs; idx++) {
		const oldLine = removed[idx];
		const newLine = added[idx];
		if (oldLine.content.length === 0 || newLine.content.length === 0) continue;
		if (similarity(oldLine.content, newLine.content) <= HIGHLIGHT_SIMILARITY) continue;

		const { oldHighlights, newHighlights } = findCharacterDiff(oldLine.content, newLine.content);
		if (oldHighlights.length > 0) oldLine.highlights = oldHighlights;
		if (newHighlights.length > 0) newLine.highlights = newHighlights;
	}
}

/** Shared characters, in order, over the longer line's length. */
function similarity(str1: string, str2: string): number {
	const maxLen = Math.max(str1.length, str2.length);
	return maxLen === 0 ? 0 : countCommon(str1.split(''), str2.split('')) / maxLen;
}

/** Character-level diff for highlighting specific changes within lines. */
function findCharacterDiff(
	oldLine: string,
	newLine: string
): { oldHighlights: DiffRange[]; newHighlights: DiffRange[] } {
	const oldHighlights: DiffRange[] = [];
	const newHighlights: DiffRange[] = [];

	let prefixLen = 0;
	const minLen = Math.min(oldLine.length, newLine.length);
	while (prefixLen < minLen && oldLine[prefixLen] === newLine[prefixLen]) prefixLen++;

	let suffixLen = 0;
	const maxSuffixLen = minLen - prefixLen;
	while (
		suffixLen < maxSuffixLen &&
		oldLine[oldLine.length - 1 - suffixLen] === newLine[newLine.length - 1 - suffixLen]
	) {
		suffixLen++;
	}

	const oldMiddleEnd = oldLine.length - suffixLen;
	const newMiddleEnd = newLine.length - suffixLen;
	if (prefixLen >= oldMiddleEnd && prefixLen >= newMiddleEnd) return { oldHighlights, newHighlights };

	const oldMiddle = oldLine.substring(prefixLen, oldMiddleEnd);
	const newMiddle = newLine.substring(prefixLen, newMiddleEnd);

	if (oldMiddle.length === 0 || newMiddle.length === 0 || !hasCommonSubstring(oldMiddle, newMiddle)) {
		if (oldMiddle.length > 0) oldHighlights.push({ start: prefixLen, end: oldMiddleEnd });
		if (newMiddle.length > 0) newHighlights.push({ start: prefixLen, end: newMiddleEnd });
		return { oldHighlights, newHighlights };
	}

	const middleDiff = findFineDiff(oldMiddle, newMiddle);
	for (const range of middleDiff.oldRanges) {
		oldHighlights.push({ start: prefixLen + range.start, end: prefixLen + range.end });
	}
	for (const range of middleDiff.newRanges) {
		newHighlights.push({ start: prefixLen + range.start, end: prefixLen + range.end });
	}
	return { oldHighlights, newHighlights };
}

/** Whether the two strings share any run of `minLength` characters. */
function hasCommonSubstring(str1: string, str2: string, minLength = 3): boolean {
	if (str1.length < minLength || str2.length < minLength) return false;

	// One pass per side: a `str2.includes()` per position of str1 was
	// quadratic, and one long minified line was enough to stall the tab.
	const grams = new Set<string>();
	for (let i = 0; i <= str2.length - minLength; i++) grams.add(str2.substring(i, i + minLength));
	for (let i = 0; i <= str1.length - minLength; i++) {
		if (grams.has(str1.substring(i, i + minLength))) return true;
	}
	return false;
}

/** Word-level diff of two strings, as merged character ranges per side. */
function findFineDiff(oldStr: string, newStr: string): { oldRanges: DiffRange[]; newRanges: DiffRange[] } {
	const oldRanges: DiffRange[] = [];
	const newRanges: DiffRange[] = [];
	const oldChunks = splitIntoChunks(oldStr);
	const newChunks = splitIntoChunks(newStr);

	for (const op of diffSequences(oldChunks.map((c) => c.text), newChunks.map((c) => c.text))) {
		if (op.type === 'delete') {
			const chunk = oldChunks[op.oldIndex];
			oldRanges.push({ start: chunk.start, end: chunk.end });
		} else if (op.type === 'insert') {
			const chunk = newChunks[op.newIndex];
			newRanges.push({ start: chunk.start, end: chunk.end });
		}
	}

	return { oldRanges: mergeRanges(oldRanges), newRanges: mergeRanges(newRanges) };
}

function splitIntoChunks(str: string): Array<{ text: string; start: number; end: number }> {
	const chunks: Array<{ text: string; start: number; end: number }> = [];
	const regex = /(\w+|[^\w]+)/g;
	let match;
	while ((match = regex.exec(str)) !== null) {
		chunks.push({ text: match[0], start: match.index, end: match.index + match[0].length });
	}
	return chunks;
}

function mergeRanges(ranges: DiffRange[]): DiffRange[] {
	if (ranges.length === 0) return [];
	ranges.sort((a, b) => a.start - b.start);
	const merged: DiffRange[] = [];
	let current = ranges[0];
	for (let i = 1; i < ranges.length; i++) {
		const next = ranges[i];
		if (next.start <= current.end) {
			current = { start: current.start, end: Math.max(current.end, next.end) };
		} else {
			merged.push(current);
			current = next;
		}
	}
	merged.push(current);
	return merged;
}
