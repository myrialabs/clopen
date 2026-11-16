import { describe, expect, test } from 'bun:test';

import { computeDiffBlock } from './diff-block';

describe('computeDiffBlock', () => {
	test('lists unchanged lines in place and each changed region as removed then added', () => {
		const rows = computeDiffBlock('a\nb\nc', 'a\nB\nX\nc', { highlights: false });
		expect(rows.map((row) => [row.type, row.content])).toEqual([
			['unchanged', 'a'],
			['removed', 'b'],
			['added', 'B'],
			['added', 'X'],
			['unchanged', 'c']
		]);
	});

	test('highlights only the characters that changed in a similar line', () => {
		const rows = computeDiffBlock('const value = 1;', 'const value = 2;', { highlights: true });
		const removed = rows.find((row) => row.type === 'removed')!;
		const added = rows.find((row) => row.type === 'added')!;
		expect(removed.highlights).toEqual([{ start: 14, end: 15 }]);
		expect(added.highlights).toEqual([{ start: 14, end: 15 }]);
	});

	test('strips indentation shared by both sides', () => {
		const rows = computeDiffBlock('\t\tif (a) {', '\t\tif (b) {', { highlights: false });
		expect(rows.map((row) => row.content)).toEqual(['if (a) {', 'if (b) {']);
	});

	test('handles a whole large file with one edit', () => {
		const before = Array.from({ length: 50_000 }, (_, i) => `line ${i}`);
		const after = [...before];
		after[25_000] = 'changed';
		const rows = computeDiffBlock(before.join('\n'), after.join('\n'), { highlights: true });
		expect(rows.filter((row) => row.type !== 'unchanged')).toHaveLength(2);
	});
});
