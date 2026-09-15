/**
 * Carrying one turn's hunks onto the buffer.
 *
 * This is what makes "show me turn 2" mean turn 2 and not turn 2 plus
 * everything after it. The turn's hunks are computed against its own before and
 * after; the buffer has moved on; these functions are the translation, and the
 * cases that matter are the ones where the translation cannot be made — a line
 * a later turn deleted has nowhere to be painted.
 */

import { describe, expect, test } from 'bun:test';

import { buildLineMap, remapHunks } from './line-map';
import { computeLineDiff } from './line-diff';

/** The map between two texts, as the gutter builds it. */
function mapBetween(older: string, newer: string) {
	return buildLineMap(computeLineDiff(older, newer));
}

describe('buildLineMap', () => {
	test('maps every line through when nothing moved', () => {
		const map = mapBetween('a\nb\nc', 'a\nb\nc');

		expect([1, 2, 3].map(map)).toEqual([1, 2, 3]);
	});

	test('shifts lines down past an insertion above them', () => {
		const map = mapBetween('a\nb\nc', 'a\nNEW\nb\nc');

		expect(map(1)).toBe(1);
		expect(map(2)).toBe(3);
		expect(map(3)).toBe(4);
	});

	test('shifts lines up past a deletion above them', () => {
		const map = mapBetween('a\nb\nc\nd', 'a\nc\nd');

		expect(map(1)).toBe(1);
		// 'b' is gone — it has nowhere to be painted.
		expect(map(2)).toBeNull();
		expect(map(3)).toBe(2);
		expect(map(4)).toBe(3);
	});

	test('drops a line that was rewritten, since it is no longer that line', () => {
		const map = mapBetween('a\nb\nc', 'a\nBBB\nc');

		expect(map(1)).toBe(1);
		expect(map(2)).toBeNull();
		expect(map(3)).toBe(3);
	});

	test('handles several hunks at once', () => {
		const map = mapBetween('a\nb\nc\nd\ne', 'NEW\na\nc\nd\nX\ne');

		expect(map(1)).toBe(2); // a, pushed down by the prepended line
		expect(map(2)).toBeNull(); // b, deleted
		expect(map(3)).toBe(3); // c
		expect(map(4)).toBe(4); // d
		expect(map(5)).toBe(6); // e, pushed down by X
	});

	test('answers null outside the file', () => {
		const map = mapBetween('a\nb', 'a\nb');

		expect(map(0)).toBeNull();
		expect(map(-3)).toBeNull();
	});
});

describe('remapHunks', () => {
	test('leaves hunks alone when the revisions are identical', () => {
		const before = 'a\nb\nc';
		const after = 'a\nB\nc';
		const hunks = computeLineDiff(before, after);

		const remapped = remapHunks(hunks, mapBetween(after, after));

		expect(remapped).toHaveLength(1);
		expect(remapped[0].startLine).toBe(2);
		expect(remapped[0].endLine).toBe(2);
		expect(remapped[0].exact).toBe(true);
	});

	test('moves a hunk down when a later change inserted lines above it', () => {
		const before = 'a\nb\nc';
		const after = 'a\nB\nc';
		const buffer = 'HEADER\na\nB\nc';
		const hunks = computeLineDiff(before, after);

		const remapped = remapHunks(hunks, mapBetween(after, buffer));

		expect(remapped).toHaveLength(1);
		expect(remapped[0].startLine).toBe(3);
		expect(remapped[0].exact).toBe(true);
	});

	test('drops a hunk whose lines a later change removed', () => {
		const before = 'a\nb\nc';
		const after = 'a\nB\nc';
		const buffer = 'a\nc';
		const hunks = computeLineDiff(before, after);

		expect(remapHunks(hunks, mapBetween(after, buffer))).toEqual([]);
	});

	test('keeps a partly surviving hunk but marks it inexact, so it cannot be discarded', () => {
		const before = 'a\nb\nc\nd';
		const after = 'a\nX\nY\nd';
		// A later change rewrote Y but left X alone.
		const buffer = 'a\nX\nZZZ\nd';
		const hunks = computeLineDiff(before, after);

		const remapped = remapHunks(hunks, mapBetween(after, buffer));

		expect(remapped).toHaveLength(1);
		expect(remapped[0].exact).toBe(false);
	});

	test('anchors a deletion marker on the surviving line it points at', () => {
		const before = 'a\nb\nc';
		const after = 'a\nc';
		const buffer = 'HEADER\na\nc';
		const hunks = computeLineDiff(before, after);

		const remapped = remapHunks(hunks, mapBetween(after, buffer));

		expect(remapped).toHaveLength(1);
		expect(remapped[0].type).toBe('deleted');
		expect(remapped[0].startLine).toBe(3);
	});

	test('drops a deletion marker whose anchor line is itself gone', () => {
		const before = 'a\nb\nc';
		const after = 'a\nc';
		const buffer = 'a';
		const hunks = computeLineDiff(before, after);

		expect(remapHunks(hunks, mapBetween(after, buffer))).toEqual([]);
	});

	test('keeps the pre-turn lines, which is what a discard reverts to', () => {
		const before = 'a\nb\nc';
		const after = 'a\nB\nc';
		const hunks = computeLineDiff(before, after);

		const remapped = remapHunks(hunks, mapBetween(after, 'HEADER\na\nB\nc'));

		expect(remapped[0].oldLines).toEqual(['b']);
	});
});
