import { describe, expect, test } from 'bun:test';

import { placeDelta } from './stream-delta';

/** Feed deltas in an arbitrary order with duplicates; the result must equal the source. */
function replay(source: string, cut: number, order: (deltas: Array<[number, string]>) => Array<[number, string]>) {
	const deltas: Array<[number, string]> = [];
	for (let at = 0; at < source.length; at += cut) deltas.push([at, source.slice(at, at + cut)]);
	let text = '';
	let gaps = 0;
	for (const [offset, delta] of order(deltas)) {
		const placed = placeDelta(text, offset, delta);
		if (placed.kind === 'extended') text = placed.text;
		if (placed.kind === 'gap') gaps++;
	}
	return { text, gaps };
}

describe('placeDelta', () => {
	const source = 'The quick brown fox — ✓ jumps over the lazy dog 😀.';

	test('appends deltas that arrive in order', () => {
		expect(replay(source, 5, (d) => d)).toEqual({ text: source, gaps: 0 });
	});

	test('ignores a delta seen twice', () => {
		expect(replay(source, 5, (d) => d.flatMap((x) => [x, x]))).toEqual({ text: source, gaps: 0 });
	});

	test('adds only the new tail of a delta that overlaps text already held (a snapshot)', () => {
		expect(placeDelta('The qu', 4, 'quick')).toEqual({ kind: 'extended', text: 'The quick' });
	});

	test('reports a gap instead of placing a delta past the end', () => {
		expect(placeDelta('The', 9, 'brown')).toEqual({ kind: 'gap' });
	});

	test('a missed frame shows up as a gap, never as a hole in the text', () => {
		const result = replay(source, 5, (d) => d.filter((_, i) => i !== 3));
		expect(result.gaps).toBeGreaterThan(0);
		expect(source.startsWith(result.text)).toBe(true);
	});
});
