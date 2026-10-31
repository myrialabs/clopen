import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { gitService } from './git-service';

/**
 * Pull strategies, force pull, branch pruning and clean previews against a
 * real remote: a bare repository with two clones — `local`, the checkout the
 * panel works in, and `other`, standing in for a teammate who pushes.
 */

// The machine's own git config (pull.rebase, init.defaultBranch, signing) must
// not decide what these tests see.
const savedEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_SYSTEM };
beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = '/dev/null';
	process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});
afterAll(() => {
	if (savedEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL;
	else process.env.GIT_CONFIG_GLOBAL = savedEnv.global;
	if (savedEnv.system === undefined) delete process.env.GIT_CONFIG_SYSTEM;
	else process.env.GIT_CONFIG_SYSTEM = savedEnv.system;
});

let root: string;
let local: string;
let other: string;

async function git(cwd: string, ...args: string[]) {
	const result = await execGit(args, cwd);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout.trim();
}

async function configure(cwd: string) {
	await git(cwd, 'config', 'user.email', 'test@example.com');
	await git(cwd, 'config', 'user.name', 'Test');
	await git(cwd, 'config', 'commit.gpgsign', 'false');
}

async function commitFile(cwd: string, file: string, content: string, message: string) {
	await writeFile(path.join(cwd, file), content);
	await git(cwd, 'add', file);
	await git(cwd, 'commit', '-m', message);
}

/** A teammate's commit, pushed to the shared remote. */
async function pushFromOther(file: string, content: string, message: string) {
	await git(other, 'pull', '--no-rebase', 'origin', 'main');
	await commitFile(other, file, content, message);
	await git(other, 'push', 'origin', 'main');
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'clopen-sync-'));
	const bare = path.join(root, 'remote.git');
	await git(root, 'init', '--bare', '-b', 'main', bare);

	local = path.join(root, 'local');
	await git(root, 'clone', bare, local);
	await configure(local);
	await commitFile(local, 'shared.txt', 'base\n', 'base');
	await git(local, 'push', '-u', 'origin', 'main');

	other = path.join(root, 'other');
	await git(root, 'clone', bare, other);
	await configure(other);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('pull', () => {
	test('reports how many commits actually arrived', async () => {
		await pushFromOther('a.txt', 'a\n', 'a');
		await pushFromOther('b.txt', 'b\n', 'b');

		const result = await gitService.pull(local, 'origin', 'main');
		expect(result.success).toBe(true);
		expect(result.pulledCount).toBe(2);
	});

	test('reports a divergence with counts instead of git\'s raw fatal', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'mine.txt', 'mine\n', 'mine');

		const result = await gitService.pull(local, 'origin', 'main', 'ff-only');
		expect(result.success).toBe(false);
		expect(result.reason).toBe('diverged');
		expect(result.ahead).toBe(1);
		expect(result.behind).toBe(1);
	});

	test('merges a diverged branch when asked to', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'mine.txt', 'mine\n', 'mine');

		const result = await gitService.pull(local, 'origin', 'main', 'merge');
		expect(result.success).toBe(true);
		expect(existsSync(path.join(local, 'theirs.txt'))).toBe(true);
		expect(existsSync(path.join(local, 'mine.txt'))).toBe(true);
	});

	test('rebases a diverged branch on a dirty tree (autostash)', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'mine.txt', 'mine\n', 'mine');
		await writeFile(path.join(local, 'mine.txt'), 'mine, edited\n');

		const result = await gitService.pull(local, 'origin', 'main', 'rebase');
		expect(result.success).toBe(true);
		expect(await git(local, 'log', '-1', '--format=%s', 'HEAD~1')).toBe('theirs');
		expect(await readFile(path.join(local, 'mine.txt'), 'utf8')).toBe('mine, edited\n');
	});

	test('flags local changes the pull would overwrite, and autostash gets past them', async () => {
		await commitFile(local, 'lines.txt', '1\n2\n3\n', 'lines');
		await git(local, 'push', 'origin', 'main');
		await pushFromOther('lines.txt', 'one\n2\n3\n', 'edit line 1');
		await writeFile(path.join(local, 'lines.txt'), '1\n2\nthree\n');

		const blocked = await gitService.pull(local, 'origin', 'main', 'merge');
		expect(blocked.success).toBe(false);
		expect(blocked.reason).toBe('local-changes');

		const stashed = await gitService.pull(local, 'origin', 'main', 'merge', true);
		expect(stashed.success).toBe(true);
		expect(await readFile(path.join(local, 'lines.txt'), 'utf8')).toBe('one\n2\nthree\n');
	});

	test('flags conflicts', async () => {
		await pushFromOther('shared.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'shared.txt', 'mine\n', 'mine');

		const result = await gitService.pull(local, 'origin', 'main', 'merge');
		expect(result.success).toBe(false);
		expect(result.reason).toBe('conflict');
	});
});

describe('force pull', () => {
	test('previews what would be lost without changing anything', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'mine.txt', 'mine\n', 'mine');
		await writeFile(path.join(local, 'shared.txt'), 'dirty\n');
		await writeFile(path.join(local, 'theirs.txt'), 'untracked collision\n');

		const headBefore = await git(local, 'rev-parse', 'HEAD');
		const preview = await gitService.forcePullPreview(local, 'origin', 'main');
		expect(preview.target).toBe('origin/main');
		expect(preview.localCommits).toBe(1);
		expect(preview.incomingCommits).toBe(1);
		expect(preview.changedFiles).toBe(1);
		expect(preview.collidingUntracked).toEqual(['theirs.txt']);
		expect(await git(local, 'rev-parse', 'HEAD')).toBe(headBefore);
	});

	test('resets to the remote, stashing tracked changes and colliding untracked files only', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		await commitFile(local, 'mine.txt', 'mine\n', 'mine');
		await writeFile(path.join(local, 'shared.txt'), 'dirty\n');
		await writeFile(path.join(local, 'theirs.txt'), 'untracked collision\n');
		await writeFile(path.join(local, 'scratch.txt'), 'leave me\n');

		const result = await gitService.forcePull(local, 'origin', 'main');

		expect(result.discardedCommits).toBe(1);
		expect(result.stashMessage).toMatch(/before force pull of main/);
		expect(await git(local, 'rev-parse', 'HEAD')).toBe(await git(local, 'rev-parse', 'origin/main'));
		expect(await readFile(path.join(local, 'theirs.txt'), 'utf8')).toBe('theirs\n');
		expect(await readFile(path.join(local, 'shared.txt'), 'utf8')).toBe('base\n');
		// Untracked files the remote does not have are none of its business.
		expect(await readFile(path.join(local, 'scratch.txt'), 'utf8')).toBe('leave me\n');

		const stashed = await git(local, 'stash', 'show', '--include-untracked', '--name-only', 'stash@{0}');
		expect(stashed.split('\n').sort()).toEqual(['shared.txt', 'theirs.txt']);
	});

	test('creates no stash when the tree is clean', async () => {
		await pushFromOther('theirs.txt', 'theirs\n', 'theirs');
		const result = await gitService.forcePull(local, 'origin', 'main');
		expect(result.stashMessage).toBeUndefined();
		expect(result.discardedCommits).toBe(0);
		expect(await git(local, 'stash', 'list')).toBe('');
	});

	test('refuses a branch that does not exist on the remote', async () => {
		await git(local, 'checkout', '-b', 'local-only');
		await expect(gitService.forcePull(local, 'origin', 'local-only')).rejects.toThrow(/does not exist on the remote/);
	});
});

describe('prune branches', () => {
	test('offers merged branches, never the current or default one', async () => {
		await git(local, 'branch', 'merged-one');
		await git(local, 'checkout', '-b', 'unmerged');
		await commitFile(local, 'u.txt', 'u\n', 'unmerged work');
		await git(local, 'checkout', 'main');

		const { defaultBranch, candidates } = await gitService.getPruneCandidates(local, 'merged', 'origin');
		expect(defaultBranch).toBe('main');
		expect(candidates).toEqual([{ name: 'merged-one', merged: true }]);
	});

	test('offers branches whose upstream is gone, flagging unmerged ones', async () => {
		await git(local, 'checkout', '-b', 'feature');
		await commitFile(local, 'f.txt', 'f\n', 'feature');
		await git(local, 'push', '-u', 'origin', 'feature');
		await git(local, 'checkout', 'main');
		await git(local, 'push', 'origin', '--delete', 'feature');
		await git(local, 'fetch', '--prune', 'origin');

		const { candidates } = await gitService.getPruneCandidates(local, 'gone', 'origin');
		expect(candidates).toEqual([{ name: 'feature', merged: false }]);

		const result = await gitService.deleteBranches(local, ['feature', 'main']);
		expect(result.deleted).toEqual(['feature']);
		expect(result.failed.map(f => f.name)).toEqual(['main']);
	});
});

describe('clean preview', () => {
	test('lists untracked files, and ignored ones only when asked', async () => {
		await commitFile(local, '.gitignore', '.env\n', 'ignore env');
		await writeFile(path.join(local, '.env'), 'SECRET=1\n');
		await writeFile(path.join(local, 'stray.txt'), 'x\n');

		expect(await gitService.cleanPreview(local)).toEqual(['stray.txt']);
		expect((await gitService.cleanPreview(local, true)).sort()).toEqual(['.env', 'stray.txt']);
		// The preview deleted nothing.
		expect(existsSync(path.join(local, '.env'))).toBe(true);
	});
});

describe('stash including untracked files', () => {
	test('takes untracked files with it', async () => {
		await writeFile(path.join(local, 'new.txt'), 'new\n');
		await gitService.stashSave(local, 'with untracked', false, {}, true);
		expect(existsSync(path.join(local, 'new.txt'))).toBe(false);
	});

	test('refuses to combine with staged-only', async () => {
		await expect(gitService.stashSave(local, undefined, true, {}, true)).rejects.toThrow(/not both/);
	});
});
