import { describe, expect, test } from 'bun:test';
import { computeLineDiff, type GutterChange } from './line-diff';

const lines = (n: number, prefix = 'line') =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`);

const changedLineCount = (changes: GutterChange[]) =>
	changes.reduce((sum, c) => sum + c.oldLines.length + c.newLines.length, 0);

/**
 * Reference LCS diff — the textbook O(m*n) solution, correct but unusable at
 * scale. Tests compare against it to prove the real implementation stays
 * minimal on inputs small enough for the reference to run.
 */
function referenceChangedCount(a: string[], b: string[]): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
		}
	}
	return m + n - 2 * dp[m][n];
}

/** Every hunk must quote exactly the lines its own line numbers point at. */
function expectConsistent(changes: GutterChange[], headContent: string, currentContent: string) {
	const oldLines = headContent.split('\n');
	const newLines = currentContent.split('\n');
	for (const change of changes) {
		if (change.oldLines.length > 0) {
			expect(change.oldStartLine).toBeGreaterThan(0);
			expect(oldLines.slice(change.oldStartLine - 1, change.oldEndLine)).toEqual(change.oldLines);
		}
		if (change.newLines.length > 0) {
			expect(newLines.slice(change.startLine - 1, change.endLine)).toEqual(change.newLines);
		}
		expect(change.startLine).toBeGreaterThan(0);
		expect(change.endLine).toBeGreaterThanOrEqual(change.startLine);
	}
}

describe('computeLineDiff', () => {
	test('reports no change for identical content', () => {
		expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toEqual([]);
	});

	test('reports an inserted block as added', () => {
		const changes = computeLineDiff('a\nb\nc', 'a\nx\ny\nb\nc');
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('added');
		expect(changes[0].startLine).toBe(2);
		expect(changes[0].endLine).toBe(3);
		expect(changes[0].newLines).toEqual(['x', 'y']);
		expect(changes[0].oldLines).toEqual([]);
	});

	test('reports a replaced line as modified with both sides quoted', () => {
		const changes = computeLineDiff('a\nb\nc', 'a\nB\nc');
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('modified');
		expect(changes[0].oldLines).toEqual(['b']);
		expect(changes[0].newLines).toEqual(['B']);
		expect(changes[0].oldStartLine).toBe(2);
	});

	test('anchors a deletion on the surviving line that follows it', () => {
		const changes = computeLineDiff('a\nb\nc\nd', 'a\nd');
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('deleted');
		expect(changes[0].oldLines).toEqual(['b', 'c']);
		expect(changes[0].newLines).toEqual([]);
		expect(changes[0].startLine).toBe(2);
	});

	test('treats an empty HEAD as a wholly added file', () => {
		const changes = computeLineDiff('', 'a\nb');
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('modified');
		expect(changes[0].newLines).toEqual(['a', 'b']);
	});

	test('handles CRLF content without losing the carriage returns', () => {
		const head = ['a\r', 'b\r', 'c\r'].join('\n');
		const current = ['a\r', 'B\r', 'c\r'].join('\n');
		const changes = computeLineDiff(head, current);
		expect(changes).toHaveLength(1);
		expect(changes[0].newLines).toEqual(['B\r']);
		expectConsistent(changes, head, current);
	});
});

describe('large files (regression: issue #377)', () => {
	test('marks a single edit in a 20k-line file', () => {
		const head = lines(20780);
		const current = head.slice();
		current[20776] = 'q += " UNION ALL "';
		const changes = computeLineDiff(head.join('\n'), current.join('\n'));
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('modified');
		expect(changes[0].startLine).toBe(20777);
		expect(changes[0].newLines).toEqual(['q += " UNION ALL "']);
	});

	test('marks an inserted block in a 20k-line file', () => {
		const head = lines(20780);
		const current = head.slice();
		current.splice(20777, 0, 'inserted a', 'inserted b');
		const changes = computeLineDiff(head.join('\n'), current.join('\n'));
		expect(changes).toHaveLength(1);
		expect(changes[0].type).toBe('added');
		expect(changes[0].newLines).toEqual(['inserted a', 'inserted b']);
	});

	test('marks edits at both extremes, where trimming common ends gains nothing', () => {
		const head = lines(20000);
		const current = head.slice();
		current[0] = 'header changed';
		current[19999] = 'footer changed';
		const changes = computeLineDiff(head.join('\n'), current.join('\n'));
		expect(changes).toHaveLength(2);
		expect(changes[0].startLine).toBe(1);
		expect(changes[1].endLine).toBe(20000);
	});

	test('marks a 100k-line file with one edit', () => {
		const head = lines(100000);
		const current = head.slice();
		current[99000] = 'changed';
		const changes = computeLineDiff(head.join('\n'), current.join('\n'));
		expect(changes).toHaveLength(1);
		expect(changes[0].startLine).toBe(99001);
	});
});

describe('invariants', () => {
	test('differing content always yields at least one hunk', () => {
		// The failure this guards against is silent: a modified file rendering an
		// unmarked gutter, which is what issue #377 reported.
		const cases: Array<[string, string[], string[]]> = [
			['every line reindented', lines(20000), lines(20000).map((l) => `\t${l}`)],
			['file replaced wholesale', lines(20000), lines(18000, 'other')],
			['4000-line block deleted', lines(20000), [...lines(20000).slice(0, 5000), ...lines(20000).slice(9000)]],
			['no unique lines at all', new Array(50000).fill('    pass'), [
				...new Array(25000).fill('    pass'),
				'    return',
				...new Array(24999).fill('    pass')
			]],
			['two alternating values', Array.from({ length: 20000 }, (_, i) => (i % 2 ? 'a' : 'b')), [
				...Array.from({ length: 10000 }, (_, i) => (i % 2 ? 'a' : 'b')),
				'c',
				...Array.from({ length: 10000 }, (_, i) => (i % 2 ? 'a' : 'b'))
			]],
			['fully reversed', lines(20000), lines(20000).reverse()]
		];

		for (const [label, head, current] of cases) {
			const changes = computeLineDiff(head.join('\n'), current.join('\n'));
			expect(changes.length, `${label} produced an empty gutter`).toBeGreaterThan(0);
			expectConsistent(changes, head.join('\n'), current.join('\n'));
		}
	});

	test('stays within a time budget on inputs that defeat an O(m*n) diff', () => {
		// These same inputs cost seconds and hundreds of MB under a full LCS table.
		const started = performance.now();
		for (const [head, current] of [
			[lines(20000), lines(20000).map((l) => `\t${l}`)],
			[lines(20000), lines(18000, 'other')],
			[lines(100000), (() => { const c = lines(100000); c[50000] = 'changed'; return c; })()]
		] as Array<[string[], string[]]>) {
			expect(computeLineDiff(head.join('\n'), current.join('\n')).length).toBeGreaterThan(0);
		}
		expect(performance.now() - started).toBeLessThan(2000);
	});

	test('never reports fewer changed lines than the minimal diff, and matches it on ordinary edits', () => {
		let seed = 20260626;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		const alphabet = ['import os', 'def f():', '    return 1', '', '# comment', 'x = 2', 'class A:'];
		const pick = () => alphabet[Math.floor(rnd() * alphabet.length)];

		for (let iteration = 0; iteration < 400; iteration++) {
			const head = Array.from({ length: Math.floor(rnd() * 40) }, pick);
			const current = head.slice();
			const mutations = Math.floor(rnd() * 8);
			for (let m = 0; m < mutations; m++) {
				if (current.length === 0 || rnd() < 0.4) {
					current.splice(Math.floor(rnd() * (current.length + 1)), 0, pick());
				} else if (rnd() < 0.5) {
					current.splice(Math.floor(rnd() * current.length), 1);
				} else {
					current[Math.floor(rnd() * current.length)] = pick();
				}
			}

			const headContent = head.join('\n');
			const currentContent = current.join('\n');
			const changes = computeLineDiff(headContent, currentContent);

			if (headContent === currentContent) {
				expect(changes).toEqual([]);
				continue;
			}
			expect(changes.length).toBeGreaterThan(0);
			expectConsistent(changes, headContent, currentContent);
			expect(changedLineCount(changes)).toBe(
				referenceChangedCount(headContent.split('\n'), currentContent.split('\n'))
			);
		}
	});
});
