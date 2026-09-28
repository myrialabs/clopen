import { describe, expect, test } from 'bun:test';
import { naturalCompare } from './compare';

const sort = (names: string[]) => [...names].sort(naturalCompare);

describe('naturalCompare', () => {
	test('orders digit runs by value, not lexicographically', () => {
		expect(sort(['issue-109.ts', 'issue-36.ts'])).toEqual(['issue-36.ts', 'issue-109.ts']);
		expect(sort(['file10.ts', 'file2.ts'])).toEqual(['file2.ts', 'file10.ts']);
		expect(sort(['a10b', 'a9b'])).toEqual(['a9b', 'a10b']);
	});

	test('still sorts plain names alphabetically', () => {
		expect(sort(['src', 'assets', 'docs'])).toEqual(['assets', 'docs', 'src']);
	});

	test('groups case and diacritic variants, then orders them deterministically', () => {
		expect(naturalCompare('README.md', 'readme.md')).toBeLessThan(0);
		expect(naturalCompare('cafe.md', 'café.md')).toBeLessThan(0);
		expect(naturalCompare('apple.md', 'äpple.md')).toBeLessThan(0);
		expect(naturalCompare('a', 'a')).toBe(0);
	});

	test('gives the same order regardless of input order (no readdir fallback)', () => {
		expect(sort(['readme.md', 'README.md'])).toEqual(sort(['README.md', 'readme.md']));
		expect(sort(['café.md', 'cafe.md', 'Cafe.md'])).toEqual(sort(['Cafe.md', 'café.md', 'cafe.md']));
	});

	test('is independent of the ambient locale', () => {
		// `cs` sorts "ch" after "h" and `sv` sorts "ä" last — a browser in
		// either locale must not re-order what the backend already sorted.
		expect(naturalCompare('changelog.md', 'horse.md')).toBeLessThan(0);
		expect(naturalCompare('apple.md', 'äpple.md')).toBeLessThan(0);
	});

	test('is antisymmetric and reflexive', () => {
		const names = ['issue-10.ts', 'issue-2.ts', 'README.md', 'readme.md', 'cafe.md', 'äpple.md', 'a', 'A', ''];
		for (const left of names) {
			expect(naturalCompare(left, left)).toBe(0);
			for (const right of names) {
				// Equal and opposite signs — both zero only when the strings match.
				expect(Math.sign(naturalCompare(left, right)) + Math.sign(naturalCompare(right, left))).toBe(0);
			}
		}
	});
});
