import { beforeEach, describe, expect, test } from 'bun:test';
import {
	addAiChange,
	getAiChanges,
	clearAiChange,
	clearAllAiChanges,
	getFilesWithAiChanges,
	requestAiScrollReveal,
	consumeAiScrollReveal,
	latestPresentChangeIndex,
	setAiChanges,
	type AiChange
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

describe('setAiChanges', () => {
	test('rebuilds the store grouped per file, in order', () => {
		setAiChanges([
			{ filePath: FILE, oldContent: 'a', newContent: 'b', key: 'e1' },
			{ filePath: '/proj/src/bar.ts', oldContent: '', newContent: 'x', key: 'e2' },
			{ filePath: FILE, oldContent: 'b', newContent: 'c', key: 'e3' }
		]);
		expect(getAiChanges(FILE).map((c) => c.key)).toEqual(['e1', 'e3']);
		expect(getAiChanges('/proj/src/bar.ts').map((c) => c.key)).toEqual(['e2']);
	});

	test('dedupes by key within a file', () => {
		setAiChanges([
			{ filePath: FILE, oldContent: 'a', newContent: 'b', key: 'e1' },
			{ filePath: FILE, oldContent: 'a', newContent: 'b', key: 'e1' }
		]);
		expect(getAiChanges(FILE)).toHaveLength(1);
	});

	test('fully replaces prior state', () => {
		setAiChanges([{ filePath: FILE, oldContent: 'a', newContent: 'b', key: 'e1' }]);
		setAiChanges([{ filePath: '/proj/src/bar.ts', oldContent: '', newContent: 'x', key: 'e2' }]);
		expect(getAiChanges(FILE)).toEqual([]);
		expect(getFilesWithAiChanges()).toEqual(['/proj/src/bar.ts']);
	});
});

describe('latestPresentChangeIndex', () => {
	const mk = (newContent: string): AiChange => ({ oldContent: '', newContent, timestamp: 0 });

	test('returns the last index when every edit is present in the content', () => {
		const list = [mk('alpha'), mk('beta'), mk('gamma')];
		expect(latestPresentChangeIndex(list, 'alpha beta gamma')).toBe(2);
	});

	test('skips trailing edits whose content is absent (post-restore)', () => {
		// Edits A-B-C-D-E; file was restored to C, so D/E no longer appear.
		const list = [mk('A'), mk('B'), mk('C'), mk('D'), mk('E')];
		expect(latestPresentChangeIndex(list, 'A B C')).toBe(2);
	});

	test('returns -1 for an empty list', () => {
		expect(latestPresentChangeIndex([], 'anything')).toBe(-1);
	});

	test('falls back to the last index when nothing matches', () => {
		const list = [mk('x'), mk('y')];
		expect(latestPresentChangeIndex(list, 'no match here')).toBe(1);
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
