import { describe, expect, test } from 'bun:test';
import { hasGitSegment, isGitStateEvent, stripGitLockSuffix } from './file-watcher';

/**
 * These tests pin down the classification that decides whether a filesystem
 * event under a `.git` directory becomes a `git:changed` for the Git panel.
 *
 * The bug they exist to prevent: git writes almost everything atomically, by
 * creating `<name>.lock`, writing it, then renaming it onto `<name>`. macOS
 * reports that rename under the OLD name, so `<name>.lock` is very often the
 * only name that ever arrives. The watcher used to match an allowlist of final
 * names (`index`, `HEAD`, `MERGE_HEAD`, `REBASE_HEAD`) and, in the sibling
 * `refs/` watcher, to discard every `.lock` outright. Between them, an external
 * commit, checkout, branch creation, stash or tag produced no event at all —
 * the panel only refreshed when an unrelated working-tree write happened to
 * coincide with it.
 *
 * The event names below are transcribed from what the watcher actually
 * received while driving real git commands, not invented.
 */
describe('isGitStateEvent', () => {
	test('accepts the lock files git actually reports', () => {
		// `git commit`
		expect(isGitStateEvent('index.lock')).toBe(true);
		expect(isGitStateEvent('HEAD.lock')).toBe(true);
		expect(isGitStateEvent('refs/heads/main.lock')).toBe(true);
		// `git tag` / `git stash`
		expect(isGitStateEvent('refs/tags/v1.lock')).toBe(true);
		expect(isGitStateEvent('refs/stash.lock')).toBe(true);
		// `git branch -D` / `git tag -d` on a packed repo
		expect(isGitStateEvent('packed-refs.lock')).toBe(true);
	});

	test('accepts the settled names too, so no platform is left out', () => {
		// Linux reports both halves of the rename; Windows and network shares
		// differ again. Accepting only one form would move the hole, not close it.
		expect(isGitStateEvent('index')).toBe(true);
		expect(isGitStateEvent('HEAD')).toBe(true);
		expect(isGitStateEvent('refs/heads/main')).toBe(true);
		expect(isGitStateEvent('packed-refs')).toBe(true);
	});

	test('accepts in-progress operation markers the panel reads', () => {
		// `detectGitOperation` reads exactly these to render the merge/rebase
		// banner, so the watcher has to report them.
		expect(isGitStateEvent('MERGE_HEAD')).toBe(true);
		expect(isGitStateEvent('CHERRY_PICK_HEAD')).toBe(true);
		expect(isGitStateEvent('REVERT_HEAD')).toBe(true);
		expect(isGitStateEvent('BISECT_LOG')).toBe(true);
		expect(isGitStateEvent('rebase-merge/done')).toBe(true);
		expect(isGitStateEvent('rebase-apply/next')).toBe(true);
	});

	test('accepts the reflog, which is sometimes the only event delivered', () => {
		// A recursive watch on the project root reports `git branch` solely as a
		// reflog write; the ref's own lock file never surfaces there.
		expect(isGitStateEvent('logs/HEAD')).toBe(true);
		expect(isGitStateEvent('logs/refs/heads/feature')).toBe(true);
	});

	test('accepts remote-tracking updates from a fetch', () => {
		expect(isGitStateEvent('refs/remotes/origin/main.lock')).toBe(true);
		expect(isGitStateEvent('FETCH_HEAD')).toBe(true);
	});

	test('rejects pure content churn and entries the panel never reads', () => {
		expect(isGitStateEvent('objects/ea/b10512e0f8')).toBe(false);
		expect(isGitStateEvent('objects/7a/tmp_obj_WG7qLP')).toBe(false);
		expect(isGitStateEvent('lfs/tmp/abc')).toBe(false);
		expect(isGitStateEvent('hooks/pre-commit.sample')).toBe(false);
		expect(isGitStateEvent('info/exclude')).toBe(false);
		expect(isGitStateEvent('COMMIT_EDITMSG')).toBe(false);
		expect(isGitStateEvent('MERGE_MSG')).toBe(false);
	});

	test('rejects an empty or self-referential path', () => {
		expect(isGitStateEvent('')).toBe(false);
		expect(isGitStateEvent('.')).toBe(false);
	});

	test('reads Windows separators the same way', () => {
		expect(isGitStateEvent('refs\\heads\\main.lock')).toBe(true);
		expect(isGitStateEvent('objects\\ea\\b10512')).toBe(false);
	});
});

describe('stripGitLockSuffix', () => {
	test('removes the suffix only when it is one', () => {
		expect(stripGitLockSuffix('index.lock')).toBe('index');
		expect(stripGitLockSuffix('refs/heads/main.lock')).toBe('refs/heads/main');
		expect(stripGitLockSuffix('index')).toBe('index');
		// A branch legitimately named `…lock` must not lose characters.
		expect(stripGitLockSuffix('refs/heads/deadlock')).toBe('refs/heads/deadlock');
	});
});

describe('hasGitSegment', () => {
	test('recognises a git directory anywhere in the path', () => {
		expect(hasGitSegment('.git/index')).toBe(true);
		// The sub-repo case: this is the path the project's own recursive watch
		// reports when a commit is made inside a nested repo.
		expect(hasGitSegment('sdks/php/.git/refs/heads/main.lock')).toBe(true);
	});

	test('does not match names that merely start with .git', () => {
		expect(hasGitSegment('.gitignore')).toBe(false);
		expect(hasGitSegment('.github/workflows/ci.yml')).toBe(false);
		expect(hasGitSegment('src/app.ts')).toBe(false);
	});
});
