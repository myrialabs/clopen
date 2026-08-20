import { describe, expect, test } from 'bun:test';
import type { FileChangeSet } from './patch-rollout';
import { parseUnifiedDiff, findMatchingFileChangeSet } from './patch-rollout';

describe('parseUnifiedDiff', () => {
	test('splits a single hunk into before/after text', () => {
		const diff = [
			'@@ -1,4 +1,4 @@',
			' :root {',
			'-  --accent: #1d4ed8;',
			'+  --accent: #7c3aed;',
			' }',
			''
		].join('\n');

		expect(parseUnifiedDiff(diff)).toEqual({
			oldString: ':root {\n  --accent: #1d4ed8;\n}\n',
			newString: ':root {\n  --accent: #7c3aed;\n}\n'
		});
	});

	test('concatenates every hunk so the Edit block shows all changes', () => {
		const diff = [
			'@@ -1,2 +1,2 @@',
			'-first old',
			'+first new',
			' shared',
			'@@ -9,2 +9,2 @@',
			'-second old',
			'+second new',
			''
		].join('\n');

		const { oldString, newString } = parseUnifiedDiff(diff);
		expect(oldString).toBe('first old\nshared\nsecond old\n');
		expect(newString).toBe('first new\nshared\nsecond new\n');
	});

	test('ignores headers before the first hunk but keeps dashes inside one', () => {
		const diff = [
			'--- a/notes.md',
			'+++ b/notes.md',
			'@@ -1,2 +1,2 @@',
			'---',
			'+++',
			''
		].join('\n');

		// Inside a hunk `---` is a removed line whose text is `--`, and `+++`
		// an added line whose text is `++` — not file headers.
		expect(parseUnifiedDiff(diff)).toEqual({ oldString: '--\n', newString: '++\n' });
	});

	test('drops the no-newline annotation', () => {
		const diff = ['@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n');
		expect(parseUnifiedDiff(diff)).toEqual({ oldString: 'old', newString: 'new' });
	});

	test('returns empty strings for an empty diff', () => {
		expect(parseUnifiedDiff('')).toEqual({ oldString: '', newString: '' });
	});
});

describe('findMatchingFileChangeSet', () => {
	const changeSetFor = (...paths: string[]): FileChangeSet =>
		new Map(paths.map(path => [path, { kind: 'update' as const, oldString: path, newString: path, content: '' }]));

	test('prefers the newest change set that covers every wanted path', () => {
		const older = changeSetFor('/repo/a.ts');
		const newer = changeSetFor('/repo/a.ts', '/repo/b.ts');

		expect(findMatchingFileChangeSet([older, newer], ['/repo/a.ts'])).toBe(newer);
		expect(findMatchingFileChangeSet([older, newer], ['/repo/a.ts', '/repo/b.ts'])).toBe(newer);
	});

	test('skips change sets that miss one of the wanted paths', () => {
		const matching = changeSetFor('/repo/a.ts', '/repo/b.ts');
		const partial = changeSetFor('/repo/a.ts');

		expect(findMatchingFileChangeSet([matching, partial], ['/repo/a.ts', '/repo/b.ts'])).toBe(matching);
	});

	test('returns null when nothing matches or nothing is wanted', () => {
		expect(findMatchingFileChangeSet([changeSetFor('/repo/a.ts')], ['/repo/c.ts'])).toBeNull();
		expect(findMatchingFileChangeSet([changeSetFor('/repo/a.ts')], [])).toBeNull();
		expect(findMatchingFileChangeSet([], ['/repo/a.ts'])).toBeNull();
	});
});
