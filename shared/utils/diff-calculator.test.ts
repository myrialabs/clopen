/**
 * Line counting for +/- badges.
 *
 * These numbers sit next to a file name in the checkpoint timeline, the
 * Changes tab and every Edit tool row, where they are read against what git
 * says about the same file. A file that ends with a newline — which is most
 * source files — used to count one line more than it has, so the badges and
 * git disagreed on every created and deleted file.
 */

import { describe, test, expect } from 'bun:test';

import { countLineChanges, calculateFileChangeStats, isBinaryBuffer } from './diff-calculator';

describe('countLineChanges', () => {
	test('counts a created file by its real lines, trailing newline and all', () => {
		expect(countLineChanges('', 'one\ntwo\n')).toEqual({ additions: 2, deletions: 0 });
	});

	test('counts a file with no trailing newline the same way', () => {
		expect(countLineChanges('', 'one\ntwo')).toEqual({ additions: 2, deletions: 0 });
	});

	test('counts a deleted file as deletions only', () => {
		expect(countLineChanges('one\ntwo\nthree\n', '')).toEqual({ additions: 0, deletions: 3 });
	});

	test('counts only the lines that actually moved, not the context around them', () => {
		expect(countLineChanges('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ additions: 1, deletions: 1 });
	});

	test('reads CRLF as the same content as LF', () => {
		expect(countLineChanges('a\r\nb\r\n', 'a\nb\n')).toEqual({ additions: 0, deletions: 0 });
	});

	test('answers nothing for two empty sides', () => {
		expect(countLineChanges('', '')).toEqual({ additions: 0, deletions: 0 });
	});
});

describe('isBinaryBuffer', () => {
	test('calls a NUL byte binary and plain text not', () => {
		expect(isBinaryBuffer(Buffer.from([0x89, 0x50, 0x00, 0x0a]))).toBe(true);
		expect(isBinaryBuffer(Buffer.from('a\nb\n', 'utf8'))).toBe(false);
	});
});

describe('calculateFileChangeStats', () => {
	test('adds up across added, modified and deleted files', () => {
		const before = {
			'keep.ts': Buffer.from('a\nb\n'),
			'gone.ts': Buffer.from('x\ny\n')
		};
		const after = {
			'keep.ts': Buffer.from('a\nB\n'),
			'new.ts': Buffer.from('n\n')
		};

		expect(calculateFileChangeStats(before, after)).toEqual({
			filesChanged: 3,
			insertions: 2,
			deletions: 3
		});
	});

	test('counts a binary file as changed but contributes none of its bytes as lines', () => {
		// A PNG split on newline bytes yields a line count with no meaning: two
		// screenshots once added +159 to a checkpoint whose source changes were +17.
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a, 0x0a, 0x0a]);
		const before = { 'src/a.ts': Buffer.from('a\n') };
		const after = { 'src/a.ts': Buffer.from('b\n'), 'shot.png': png };

		expect(calculateFileChangeStats(before, after)).toEqual({
			filesChanged: 2,
			insertions: 1,
			deletions: 1
		});
	});

	test('counts a deleted binary the same way', () => {
		const png = Buffer.from([0x89, 0x50, 0x00, 0x0a, 0x0a]);

		expect(calculateFileChangeStats({ 'shot.png': png }, {})).toEqual({
			filesChanged: 1,
			insertions: 0,
			deletions: 0
		});
	});
});
