import { beforeEach, describe, expect, test } from 'bun:test';
import {
	addAiChange,
	getAiChanges,
	clearAiChange,
	clearAllAiChanges,
	getFilesWithAiChanges,
	requestAiScrollReveal,
	consumeAiScrollReveal
} from './ai-changes';

const FILE = '/proj/src/foo.ts';

beforeEach(() => {
	clearAllAiChanges();
});

describe('addAiChange', () => {
	test('appends distinct edits and returns their indices', () => {
		expect(addAiChange(FILE, 'a', 'b', 'id-1')).toBe(0);
		expect(addAiChange(FILE, 'b', 'c', 'id-2')).toBe(1);
		expect(getAiChanges(FILE)).toHaveLength(2);
	});

	test('dedupes by key so a remount returns the existing index, not a copy', () => {
		// Two distinct edits to the same file.
		expect(addAiChange(FILE, 'a', 'b', 'id-1')).toBe(0);
		expect(addAiChange(FILE, 'b', 'c', 'id-2')).toBe(1);

		// The first edit's tool row scrolls back into view and re-adds itself.
		// A last-entry-only compare would push a third entry here; keying by the
		// tool_use id must return the original index instead.
		expect(addAiChange(FILE, 'a', 'b', 'id-1')).toBe(0);
		expect(getAiChanges(FILE)).toHaveLength(2);
	});

	test('keyless callers fall back to a last-entry exact-match dedupe', () => {
		expect(addAiChange(FILE, 'a', 'b')).toBe(0);
		expect(addAiChange(FILE, 'a', 'b')).toBe(0); // consecutive identical → skipped
		expect(getAiChanges(FILE)).toHaveLength(1);

		expect(addAiChange(FILE, 'b', 'c')).toBe(1); // different → appended
		expect(getAiChanges(FILE)).toHaveLength(2);
	});
});

describe('file set tracking', () => {
	test('getFilesWithAiChanges lists only files with changes', () => {
		addAiChange(FILE, 'a', 'b', 'id-1');
		addAiChange('/proj/src/bar.ts', '', 'x', 'id-2');
		expect(getFilesWithAiChanges().sort()).toEqual(['/proj/src/bar.ts', FILE].sort());
	});

	test('clearAiChange removes a single file', () => {
		addAiChange(FILE, 'a', 'b', 'id-1');
		clearAiChange(FILE);
		expect(getFilesWithAiChanges()).toEqual([]);
	});

	test('clearAllAiChanges drops every file', () => {
		addAiChange(FILE, 'a', 'b', 'id-1');
		addAiChange('/proj/src/bar.ts', '', 'x', 'id-2');
		clearAllAiChanges();
		expect(getFilesWithAiChanges()).toEqual([]);
	});
});

describe('scroll-reveal signal', () => {
	test('consume returns the edit index when the path matches, then clears it', () => {
		requestAiScrollReveal(FILE, 3);
		expect(consumeAiScrollReveal(FILE)).toBe(3);
		// Second consume finds nothing pending.
		expect(consumeAiScrollReveal(FILE)).toBe(-1);
	});

	test('consume returns -1 when the path does not match the pending reveal', () => {
		requestAiScrollReveal(FILE, 3);
		expect(consumeAiScrollReveal('/proj/src/other.ts')).toBe(-1);
	});
});
