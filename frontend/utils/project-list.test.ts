import { describe, expect, test } from 'bun:test';
import {
	areAllOf,
	cleanIds,
	newlyArchived,
	retainIds,
	sortPinnedFirst,
	toggleAllOf,
	toggleId
} from './project-list';

describe('toggleId', () => {
	test('adds when absent, removes when present', () => {
		expect(toggleId(['a'], 'b')).toEqual(['a', 'b']);
		expect(toggleId(['a', 'b'], 'a')).toEqual(['b']);
	});

	test('does not mutate the input', () => {
		const ids = ['a'];
		toggleId(ids, 'b');
		expect(ids).toEqual(['a']);
	});
});

describe('cleanIds', () => {
	test('drops empties and duplicates, keeping first-seen order', () => {
		expect(cleanIds(['b', undefined, 'a', 'b', null, ''])).toEqual(['b', 'a']);
	});
});

describe('areAllOf', () => {
	test('true only when every visible id is selected', () => {
		expect(areAllOf(['a', 'b'], ['a', 'b'])).toBe(true);
		expect(areAllOf(['a'], ['a', 'b'])).toBe(false);
	});

	test('an empty visible list is not "all selected"', () => {
		// Otherwise the header checkbox renders checked over nothing.
		expect(areAllOf([], [])).toBe(false);
		expect(areAllOf(['a'], [])).toBe(false);
	});

	test('extra selections outside the visible list do not block the check', () => {
		expect(areAllOf(['a', 'b', 'hidden'], ['a', 'b'])).toBe(true);
	});
});

describe('toggleAllOf', () => {
	test('empty or partial selects every visible row', () => {
		expect(toggleAllOf([], ['a', 'b'])).toEqual(['a', 'b']);
		expect(toggleAllOf(['a'], ['a', 'b'])).toEqual(['a', 'b']);
	});

	test('fully selected clears — the bug this replaces re-selected everything', () => {
		// Unchecking Select All used to route back through "select all", so the
		// box could never clear and the counter stayed pinned at N/N.
		expect(toggleAllOf(['a', 'b'], ['a', 'b'])).toEqual([]);
	});

	test('round trip is stable: select, clear, select', () => {
		const visible = ['a', 'b', 'c'];
		const selected = toggleAllOf([], visible);
		expect(selected).toEqual(visible);
		const cleared = toggleAllOf(selected, visible);
		expect(cleared).toEqual([]);
		expect(toggleAllOf(cleared, visible)).toEqual(visible);
	});
});

describe('retainIds', () => {
	test('drops picks that fell out of the visible list', () => {
		// Select 4 projects, then type a search that matches only one: the
		// other three must not stay armed for a bulk delete.
		expect(retainIds(['a', 'b', 'c', 'd'], ['c'])).toEqual(['c']);
	});

	test('keeps selection order and leaves a fully-visible selection alone', () => {
		expect(retainIds(['b', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a']);
	});

	test('an empty visible list clears everything', () => {
		expect(retainIds(['a'], [])).toEqual([]);
	});
});

describe('sortPinnedFirst', () => {
	const projects = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

	test('pinned rise to the top', () => {
		expect(sortPinnedFirst(projects, ['c']).map((p) => p.id)).toEqual(['c', 'a', 'b', 'd']);
	});

	test('stored order is preserved within each group', () => {
		// Pinning must not reshuffle the drag-and-drop order of the rest.
		expect(sortPinnedFirst(projects, ['d', 'b']).map((p) => p.id)).toEqual(['b', 'd', 'a', 'c']);
	});

	test('does not mutate the input array', () => {
		const input = [...projects];
		sortPinnedFirst(input, ['d']);
		expect(input.map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
	});

	test('no pins leaves the order untouched', () => {
		expect(sortPinnedFirst(projects, []).map((p) => p.id)).toEqual(['a', 'b', 'c', 'd']);
	});
});

describe('newlyArchived', () => {
	test('skips ids that are already archived', () => {
		expect(newlyArchived(['a'], ['a', 'b'])).toEqual(['b']);
	});

	test('deduplicates and drops empties', () => {
		expect(newlyArchived([], ['b', 'b', undefined])).toEqual(['b']);
	});

	test('returns empty when there is nothing new to archive', () => {
		// The callers use this to decide whether to emit a notification at all.
		expect(newlyArchived(['a', 'b'], ['a', 'b'])).toEqual([]);
	});
});
