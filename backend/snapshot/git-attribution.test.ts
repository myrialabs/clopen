/**
 * Reading the reflog for HEAD moves that rewrote the working tree.
 *
 * The line that matters is between a commit and everything else: a commit
 * records files somebody already wrote, so treating it as git's own change
 * would erase an agent's work the moment it committed it.
 */

import { describe, it, expect } from 'bun:test';
import { isAuthoredCommit, parseReflog, workingTreeTransitions } from './git-attribution';

describe('isAuthoredCommit', () => {
	it('knows a commit from the working tree from one that ends a merge', () => {
		expect(isAuthoredCommit('commit: fix things')).toBe(true);
		expect(isAuthoredCommit('commit (amend): fix things')).toBe(true);
		expect(isAuthoredCommit('commit (initial): init')).toBe(true);
		expect(isAuthoredCommit('commit (merge): Merge branch x')).toBe(false);
		expect(isAuthoredCommit('merge origin/main: Merge made by the \'ort\' strategy.')).toBe(false);
		expect(isAuthoredCommit('pull: Fast-forward')).toBe(false);
	});
});

describe('workingTreeTransitions', () => {
	const reflog = parseReflog([
		'c3\tHEAD@{1000}\tmerge origin/main: Fast-forward',
		'c2\tHEAD@{990}\tcommit: agent work',
		'c1\tHEAD@{500}\tcheckout: moving from a to main'
	].join('\n'));

	it('parses sha, time and subject, newest first', () => {
		expect(reflog[0]).toEqual({ sha: 'c3', time: 1000, subject: 'merge origin/main: Fast-forward' });
		expect(reflog).toHaveLength(3);
	});

	it('keeps the moves inside the turn and skips commits', () => {
		expect(workingTreeTransitions(reflog, 'c1', 980_000)).toEqual([{ from: 'c2', to: 'c3' }]);
	});

	it('finds nothing when the turn began after the last move', () => {
		expect(workingTreeTransitions(reflog, 'c3', 2_000_000)).toEqual([]);
	});
});
