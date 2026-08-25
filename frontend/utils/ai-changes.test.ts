import { beforeEach, describe, expect, test } from 'bun:test';
import {
	addAiChange,
	getAiChanges,
	clearAiChange,
	clearAllAiChanges,
	getFilesWithAiChanges,
	requestAiScrollReveal,
	consumeAiScrollReveal,
	latestTurnIndex,
	setAiChanges,
	type AiChange,
	type AiEditEntry
} from './ai-changes';

const FILE = '/proj/src/foo.ts';

const entry = (
	filePath: string,
	oldContent: string,
	newContent: string,
	key: string,
	turnIndex = 0
): AiEditEntry => ({
	filePath,
	oldContent,
	newContent,
	key,
	turnIndex,
	checkpointMessageId: `m${turnIndex}`,
	wholeFile: oldContent === ''
});

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
			entry(FILE, 'a', 'b', 'e1'),
			entry('/proj/src/bar.ts', '', 'x', 'e2'),
			entry(FILE, 'b', 'c', 'e3')
		]);
		expect(getAiChanges(FILE).map((c) => c.key)).toEqual(['e1', 'e3']);
		expect(getAiChanges('/proj/src/bar.ts').map((c) => c.key)).toEqual(['e2']);
	});

	test('dedupes by key within a file', () => {
		setAiChanges([entry(FILE, 'a', 'b', 'e1'), entry(FILE, 'a', 'b', 'e1')]);
		expect(getAiChanges(FILE)).toHaveLength(1);
	});

	test('fully replaces prior state', () => {
		setAiChanges([entry(FILE, 'a', 'b', 'e1')]);
		setAiChanges([entry('/proj/src/bar.ts', '', 'x', 'e2')]);
		expect(getAiChanges(FILE)).toEqual([]);
		expect(getFilesWithAiChanges()).toEqual(['/proj/src/bar.ts']);
	});

	test('carries turn grouping and whole-file marking through to the store', () => {
		setAiChanges([entry(FILE, 'a', 'b', 'e1', 2), entry(FILE, '', 'whole', 'e2', 2)]);
		const list = getAiChanges(FILE);
		expect(list.map((c) => c.turnIndex)).toEqual([2, 2]);
		expect(list.map((c) => c.checkpointMessageId)).toEqual(['m2', 'm2']);
		expect(list.map((c) => c.wholeFile)).toEqual([false, true]);
	});
});

describe('latestTurnIndex', () => {
	const mk = (turnIndex: number): AiChange => ({
		oldContent: '',
		newContent: '',
		timestamp: 0,
		turnIndex,
		checkpointMessageId: null,
		wholeFile: false
	});

	test('returns the highest turn index in the list', () => {
		expect(latestTurnIndex([mk(0), mk(1), mk(1), mk(2)])).toBe(2);
	});

	test('groups every edit of the last turn, not just the final one', () => {
		// Three edits in turn 1 — "Latest AI turn" must cover all of them.
		const list = [mk(0), mk(1), mk(1), mk(1)];
		const latest = latestTurnIndex(list);
		expect(list.filter((c) => c.turnIndex === latest)).toHaveLength(3);
	});

	test('returns -1 for an empty list', () => {
		expect(latestTurnIndex([])).toBe(-1);
	});
});

describe('scroll-reveal signal', () => {
	test('consume returns the edit key when the path matches, then clears it', () => {
		requestAiScrollReveal(FILE, 'e3');
		expect(consumeAiScrollReveal(FILE)).toBe('e3');
		// Second consume finds nothing pending.
		expect(consumeAiScrollReveal(FILE)).toBeNull();
	});

	test('consume returns null when the path does not match the pending reveal', () => {
		requestAiScrollReveal(FILE, 'e3');
		expect(consumeAiScrollReveal('/proj/src/other.ts')).toBeNull();
	});
});
