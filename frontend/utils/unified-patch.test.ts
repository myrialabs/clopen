import { describe, expect, test } from 'bun:test';
import { splitUnifiedPatch } from './unified-patch';

const PATCH = [
	'@@ -1,4 +1,5 @@',
	' const a = 1;',
	'-const b = 2;',
	'+const b = 3;',
	'+const c = 4;',
	' const d = 5;',
	' const e = 6;'
].join('\n');

describe('splitUnifiedPatch', () => {
	test('rebuilds both sides of a hunk', () => {
		const sides = splitUnifiedPatch(PATCH);

		expect(sides.original).toBe('const a = 1;\nconst b = 2;\nconst d = 5;\nconst e = 6;');
		expect(sides.modified).toBe('const a = 1;\nconst b = 3;\nconst c = 4;\nconst d = 5;\nconst e = 6;');
		expect(sides.isEmpty).toBe(false);
	});

	test('numbers each side against its own file', () => {
		const sides = splitUnifiedPatch(PATCH);

		// The old file has no line for the addition, so its numbering skips it.
		expect(sides.originalLineNumbers).toEqual([1, 2, 3, 4]);
		expect(sides.modifiedLineNumbers).toEqual([1, 2, 3, 4, 5]);
	});

	test('keeps later hunks numbered from their own header', () => {
		const sides = splitUnifiedPatch(
			['@@ -1,1 +1,1 @@', ' first', '@@ -40,2 +40,2 @@', '-old', '+new'].join('\n')
		);

		expect(sides.originalLineNumbers).toEqual([1, 40]);
		expect(sides.modifiedLineNumbers).toEqual([1, 40]);
		expect(sides.original).toBe('first\nold');
		expect(sides.modified).toBe('first\nnew');
	});

	test('ignores the no-newline marker', () => {
		const sides = splitUnifiedPatch(
			['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n')
		);

		expect(sides.original).toBe('old');
		expect(sides.modified).toBe('new');
	});

	test('reports an absent or hunkless patch as empty', () => {
		expect(splitUnifiedPatch(undefined).isEmpty).toBe(true);
		expect(splitUnifiedPatch('').isEmpty).toBe(true);
		expect(splitUnifiedPatch('Binary files differ').isEmpty).toBe(true);
	});
});
