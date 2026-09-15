/**
 * The git status lookup maps.
 *
 * `map` answers "what letter does this file wear", and it deliberately falls
 * back to the index status — which means it cannot tell a staged file from an
 * unstaged one. `unstagedSet` exists because something has to: the AI-change
 * marker dims once a change has been staged, and reading that off `map` would
 * have kept every marker lit forever, which is the bug this set was added for.
 */

import { describe, expect, test } from 'bun:test';

import { buildGitStatusMaps } from './git-status';
import type { GitFileChange, GitStatus } from '$shared/types/git';

const ROOT = '/proj';

function change(path: string, indexStatus: string, workingStatus: string): GitFileChange {
	return { path, indexStatus, workingStatus } as GitFileChange;
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
	return {
		isRepo: true,
		staged: [],
		unstaged: [],
		untracked: [],
		conflicted: [],
		...overrides
	} as GitStatus;
}

describe('buildGitStatusMaps', () => {
	test('keeps a fully staged file out of the unstaged set', () => {
		const built = buildGitStatusMaps(status({ staged: [change('src/a.ts', 'M', ' ')] }), ROOT);

		// It still wears an M — it is changed, just not waiting in the working tree.
		expect(built.map.get('/proj/src/a.ts')).toBe('M');
		expect(built.unstagedSet.has('/proj/src/a.ts')).toBe(false);
	});

	test('puts a working-tree edit in the unstaged set', () => {
		const built = buildGitStatusMaps(status({ unstaged: [change('src/a.ts', ' ', 'M')] }), ROOT);

		expect(built.unstagedSet.has('/proj/src/a.ts')).toBe(true);
	});

	test('counts a partially staged file as unstaged, because part of it still is', () => {
		const built = buildGitStatusMaps(
			status({
				staged: [change('src/a.ts', 'M', 'M')],
				unstaged: [change('src/a.ts', 'M', 'M')]
			}),
			ROOT
		);

		expect(built.unstagedSet.has('/proj/src/a.ts')).toBe(true);
	});

	test('counts untracked and conflicted files as unstaged', () => {
		const built = buildGitStatusMaps(
			status({
				untracked: [change('src/new.ts', ' ', '?')],
				conflicted: [change('src/c.ts', 'U', 'U')]
			}),
			ROOT
		);

		expect(built.unstagedSet.has('/proj/src/new.ts')).toBe(true);
		expect(built.unstagedSet.has('/proj/src/c.ts')).toBe(true);
	});

	test('aggregates the loudest status onto every ancestor folder', () => {
		const built = buildGitStatusMaps(
			status({
				unstaged: [change('src/deep/a.ts', ' ', 'M')],
				conflicted: [change('src/c.ts', 'U', 'U')]
			}),
			ROOT
		);

		expect(built.folderMap.get('/proj/src/deep')).toBe('M');
		// Conflict outranks a plain modification on the shared parent.
		expect(built.folderMap.get('/proj/src')).toBe('U');
		// The project root itself is never given a status.
		expect(built.folderMap.has('/proj')).toBe(false);
	});

	test('builds Windows paths with Windows separators', () => {
		const built = buildGitStatusMaps(
			status({ unstaged: [change('src/a.ts', ' ', 'M')] }),
			'C:\\proj'
		);

		expect(built.map.has('C:\\proj\\src\\a.ts')).toBe(true);
		expect(built.unstagedSet.has('C:\\proj\\src\\a.ts')).toBe(true);
	});

	test('skips an entry with no status at all', () => {
		const built = buildGitStatusMaps(status({ unstaged: [change('src/a.ts', ' ', ' ')] }), ROOT);

		expect(built.map.size).toBe(0);
		expect(built.unstagedSet.size).toBe(0);
	});
});
