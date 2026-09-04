import { describe, expect, test } from 'bun:test';
import path from 'path';
import { isPathInside, slugifyWorktreeName, uniqueWorktreeSlug } from './paths';

describe('slugifyWorktreeName', () => {
	test('lowercases and hyphenates', () => {
		expect(slugifyWorktreeName('Refactor Auth')).toBe('refactor-auth');
	});

	test('strips characters that cannot be a directory name', () => {
		expect(slugifyWorktreeName('fix/../etc passwd')).toBe('fix-etc-passwd');
	});

	test('trims leading and trailing separators', () => {
		expect(slugifyWorktreeName('  --hello--  ')).toBe('hello');
	});

	test('returns empty when nothing usable survives', () => {
		expect(slugifyWorktreeName('///')).toBe('');
	});

	test('caps the length', () => {
		expect(slugifyWorktreeName('a'.repeat(200)).length).toBe(48);
	});
});

describe('uniqueWorktreeSlug', () => {
	test('uses the plain slug when free', () => {
		expect(uniqueWorktreeSlug('Feature X', new Set())).toBe('feature-x');
	});

	test('suffixes on collision', () => {
		expect(uniqueWorktreeSlug('Feature X', new Set(['feature-x']))).toBe('feature-x-2');
		expect(uniqueWorktreeSlug('Feature X', new Set(['feature-x', 'feature-x-2']))).toBe('feature-x-3');
	});

	test('falls back to a default stem for unusable names', () => {
		expect(uniqueWorktreeSlug('///', new Set())).toBe('worktree');
	});
});

describe('isPathInside', () => {
	const root = path.join('/tmp', 'clopen-root');

	test('accepts the root itself', () => {
		expect(isPathInside(root, root)).toBe(true);
	});

	test('accepts a nested path', () => {
		expect(isPathInside(root, path.join(root, 'src', 'index.ts'))).toBe(true);
	});

	test('rejects an escape', () => {
		expect(isPathInside(root, path.join(root, '..', 'elsewhere'))).toBe(false);
	});

	test('rejects a sibling with a shared prefix', () => {
		expect(isPathInside(root, `${root}-other`)).toBe(false);
	});
});
