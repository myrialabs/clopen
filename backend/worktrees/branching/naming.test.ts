/**
 * Tests for the branch name.
 *
 * The name is load-bearing rather than cosmetic: no provider here lets a client
 * set metadata on a branch, so when a crash lands between "the provider created
 * it" and "the row was written", the name is the ENTIRE evidence tying the leak
 * back to Clopen. These cases are the ones that break that tie.
 */

import { describe, it, expect } from 'bun:test';
import {
	branchDatabaseNameFor,
	branchNameFor,
	isClopenBranchName,
	isClopenDatabaseName,
	slugifyForBranch
} from './naming';

describe('slugifyForBranch', () => {
	it('reduces to a character class every provider accepts', () => {
		expect(slugifyForBranch('Fix Login!! (urgent)')).toBe('fix-login-urgent');
		expect(slugifyForBranch('  spaced   out  ')).toBe('spaced-out');
		expect(slugifyForBranch('under_score-and-dash')).toBe('under-score-and-dash');
	});

	it('strips accents rather than dropping the words carrying them', () => {
		expect(slugifyForBranch('café münchen')).toBe('cafe-munchen');
	});

	it('never leaves a leading or trailing dash', () => {
		// A trailing dash survives the length cap unless it is trimmed AFTER the
		// slice, which is the ordering this asserts.
		expect(slugifyForBranch('a'.repeat(39) + ' tail', 40)).not.toMatch(/-$/);
		expect(slugifyForBranch('---edge---')).toBe('edge');
	});

	it('answers empty for input with nothing sluggable in it', () => {
		expect(slugifyForBranch('!!!')).toBe('');
		expect(slugifyForBranch('')).toBe('');
	});
});

describe('branchNameFor', () => {
	it('is deterministic for the same project and worktree', () => {
		const input = { projectName: 'Acme Web', worktreeSlug: 'fix-login' };
		expect(branchNameFor(input)).toBe(branchNameFor(input));
		expect(branchNameFor(input)).toBe('clopen/acme-web/fix-login');
	});

	it('keeps the prefix even when both parts slug away to nothing', () => {
		// Without the fallbacks this would be `clopen//`, which matches the prefix
		// test but tells the orphan sweep nothing and collides with every other
		// unsluggable project.
		expect(branchNameFor({ projectName: '!!!', worktreeSlug: '???' })).toBe(
			'clopen/project/worktree'
		);
	});

	it('separates two worktrees that share a display name', () => {
		// The SLUG is used rather than the name for exactly this reason:
		// `uniqueWorktreeSlug` already guarantees uniqueness within a project, and
		// using the display name would reintroduce the collision it solves.
		const first = branchNameFor({ projectName: 'Acme', worktreeSlug: 'fix-login' });
		const second = branchNameFor({ projectName: 'Acme', worktreeSlug: 'fix-login-2' });
		expect(first).not.toBe(second);
	});
});

describe('isClopenBranchName', () => {
	it('matches what we create', () => {
		expect(isClopenBranchName(branchNameFor({ projectName: 'Acme', worktreeSlug: 'x' }))).toBe(true);
	});

	it('does not match a branch that merely mentions the word', () => {
		// The sweep OFFERS these for deletion, so a false positive puts someone
		// else's branch in front of a Delete button.
		expect(isClopenBranchName('main')).toBe(false);
		expect(isClopenBranchName('clopen')).toBe(false);
		expect(isClopenBranchName('my-clopen/thing')).toBe(false);
		expect(isClopenBranchName('preview/pr-12')).toBe(false);
	});
});

describe('branchDatabaseNameFor', () => {
	it('produces a plain SQL identifier, not a branch name', () => {
		// This one is interpolated into DDL and capped at 63 bytes by Postgres,
		// so the slashes a Neon branch name carries would be a syntax error.
		const name = branchDatabaseNameFor({ projectName: 'Acme Shop', worktreeSlug: 'fix-login' });
		expect(name).toBe('clopen_acme_shop_fix_login');
		expect(name).toMatch(/^[a-z0-9_]+$/);
	});

	it('stays inside the identifier limit, prefix intact', () => {
		// The prefix surviving the cap is what makes a leaked database findable:
		// `isClopenDatabaseName` is the whole of the evidence.
		const name = branchDatabaseNameFor({
			projectName: 'A'.repeat(80),
			worktreeSlug: 'B'.repeat(80)
		});
		expect(name.length).toBeLessThanOrEqual(63);
		expect(isClopenDatabaseName(name)).toBe(true);
	});

	it('keeps two worktrees of one project apart', () => {
		const first = branchDatabaseNameFor({ projectName: 'Acme', worktreeSlug: 'a' });
		const second = branchDatabaseNameFor({ projectName: 'Acme', worktreeSlug: 'b' });
		expect(first).not.toBe(second);
	});
});

describe('isClopenDatabaseName', () => {
	it('matches what we create and nothing that merely resembles it', () => {
		expect(isClopenDatabaseName('clopen_acme_fix_login')).toBe(true);
		expect(isClopenDatabaseName('clopen')).toBe(false);
		expect(isClopenDatabaseName('myclopen_thing')).toBe(false);
		expect(isClopenDatabaseName('postgres')).toBe(false);
	});
});
