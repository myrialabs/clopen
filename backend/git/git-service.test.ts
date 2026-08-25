import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { gitService } from './git-service';

/**
 * These cover the two states where HEAD-relative revisions don't resolve:
 * an unborn HEAD (fresh `git init`) and a lone root commit (no `HEAD~1`).
 * Both used to surface git's raw `fatal: ambiguous argument` in the UI.
 */

let repo: string;

async function git(...args: string[]) {
	const result = await execGit(args, repo);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

async function commitAll(message: string) {
	await git('add', '-A');
	await git('commit', '-m', message);
}

beforeEach(async () => {
	repo = await mkdtemp(path.join(tmpdir(), 'clopen-git-'));
	await git('init', '-b', 'main', '.');
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Test');
	await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe('undoLastCommit — no commits yet', () => {
	test('reports an actionable message instead of git\'s fatal', async () => {
		await expect(gitService.undoLastCommit(repo, 'soft')).rejects.toThrow(/no commits yet/i);
	});
});

describe('undoLastCommit — root commit', () => {
	beforeEach(async () => {
		await writeFile(path.join(repo, 'a.txt'), 'hello\n');
		await mkdir(path.join(repo, 'src'), { recursive: true });
		await writeFile(path.join(repo, 'src', 'b.txt'), 'world\n');
		await commitAll('init');
		// An unrelated untracked file must survive every mode, including --hard.
		await writeFile(path.join(repo, 'keep.txt'), 'untracked\n');
	});

	test('soft removes the commit and keeps its files staged', async () => {
		await gitService.undoLastCommit(repo, 'soft');

		const status = await gitService.getStatus(repo);
		expect(status.staged.map(f => f.path).sort()).toEqual(['a.txt', 'src/b.txt']);
		expect((await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)).exitCode).not.toBe(0);
		expect(existsSync(path.join(repo, 'keep.txt'))).toBe(true);
	});

	test('mixed removes the commit and leaves its files untracked', async () => {
		await gitService.undoLastCommit(repo, 'mixed');

		const status = await gitService.getStatus(repo);
		expect(status.staged).toHaveLength(0);
		expect(status.untracked.map(f => f.path).sort()).toEqual(['a.txt', 'keep.txt', 'src/b.txt']);
	});

	test('hard removes the commit and deletes only its files', async () => {
		await gitService.undoLastCommit(repo, 'hard');

		expect(existsSync(path.join(repo, 'a.txt'))).toBe(false);
		expect(existsSync(path.join(repo, 'src', 'b.txt'))).toBe(false);
		expect(existsSync(path.join(repo, 'keep.txt'))).toBe(true);
		expect((await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)).exitCode).not.toBe(0);
	});

	test('hard on an empty root commit leaves the repo unborn without erroring', async () => {
		await rm(path.join(repo, 'keep.txt'));
		await git('update-ref', '-d', 'HEAD');
		await git('reset');
		await git('commit', '--allow-empty', '-m', 'empty');

		await gitService.undoLastCommit(repo, 'hard');

		expect((await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)).exitCode).not.toBe(0);
	});
});

describe('undoLastCommit — with a parent commit', () => {
	test('soft moves HEAD back one commit and restages the change', async () => {
		await writeFile(path.join(repo, 'a.txt'), 'one\n');
		await commitAll('first');
		await writeFile(path.join(repo, 'a.txt'), 'two\n');
		await commitAll('second');

		await gitService.undoLastCommit(repo, 'soft');

		const log = await gitService.getLog(repo);
		expect(log.commits.map(c => c.message)).toEqual(['first']);
		const status = await gitService.getStatus(repo);
		expect(status.staged.map(f => f.path)).toEqual(['a.txt']);
	});
});

describe('other actions on a repo with no commits', () => {
	test('getLog reports an empty history rather than throwing', async () => {
		expect(await gitService.getLog(repo)).toEqual({ commits: [], total: 0, hasMore: false });
	});

	test('revertCommit explains there is nothing to revert', async () => {
		const result = await gitService.revertCommit(repo);
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/no commits yet/i);
	});

	test('amendCommit points at creating the first commit', async () => {
		await expect(gitService.amendCommit(repo)).rejects.toThrow(/no commit to amend/i);
	});

	test('stashSave explains a commit is required', async () => {
		await writeFile(path.join(repo, 'a.txt'), 'hello\n');
		await expect(gitService.stashSave(repo)).rejects.toThrow(/at least one commit/i);
	});

	test('push explains there is nothing to push', async () => {
		await git('remote', 'add', 'origin', path.join(repo, 'nonexistent.git'));
		const result = await gitService.push(repo, 'origin', 'main');
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/nothing to push/i);
	});
});
