import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { resolveGitDirs } from './git-dirs';

/**
 * The watcher used to look for a `.git` DIRECTORY at the project root and give
 * up when it found none. That silently produced no event source at all for
 * every layout below — the panel still rendered correct data (git walks up on
 * its own) but never learnt that anything had changed.
 */

let root: string;

async function git(cwd: string, ...args: string[]) {
	const result = await execGit(args, cwd);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

async function initRepo(dir: string) {
	await mkdir(dir, { recursive: true });
	await git(dir, 'init', '-b', 'main', '.');
	await git(dir, 'config', 'user.email', 'test@example.com');
	await git(dir, 'config', 'user.name', 'Test');
	await git(dir, 'config', 'commit.gpgsign', 'false');
}

async function commitSomething(dir: string, name = 'file.txt') {
	await writeFile(path.join(dir, name), 'content\n');
	await git(dir, 'add', '-A');
	await git(dir, 'commit', '-m', 'init');
}

beforeEach(async () => {
	// The temp dir is a symlink on macOS (/var -> /private/var); resolve it so
	// the paths git reports and the paths we assert on are the same strings.
	root = await realpath(await mkdtemp(path.join(tmpdir(), 'clopen-git-dirs-')));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('resolveGitDirs', () => {
	test('resolves a plain repo to its own .git', async () => {
		await initRepo(root);
		await commitSomething(root);

		const targets = await resolveGitDirs(root);

		expect(targets).toHaveLength(1);
		expect(targets[0].repoPath).toBe(root);
		expect(targets[0].gitDir).toBe(path.join(root, '.git'));
		expect(targets[0].commonDir).toBe(path.join(root, '.git'));
	});

	test('returns nothing for a directory that is not a repo', async () => {
		expect(await resolveGitDirs(root)).toEqual([]);
	});

	test('resolves a project opened at a SUBFOLDER of a repo', async () => {
		// No `.git` exists at the opened path, so the old existsSync probe found
		// nothing and the project got no git watcher whatsoever.
		await initRepo(root);
		await commitSomething(root);
		const subfolder = path.join(root, 'packages', 'web');
		await mkdir(subfolder, { recursive: true });

		const targets = await resolveGitDirs(subfolder);

		expect(targets).toHaveLength(1);
		expect(targets[0].gitDir).toBe(path.join(root, '.git'));
	});

	test('resolves a linked worktree to its own dir AND the shared common dir', async () => {
		// A worktree's `.git` is a FILE. Watching it caught nothing, and `refs/`
		// does not exist beneath it — the branch list lives in the common dir.
		await initRepo(root);
		await commitSomething(root);
		const worktree = path.join(root, '..', path.basename(root) + '-wt');
		await git(root, 'worktree', 'add', '-b', 'side', worktree);

		try {
			const targets = await resolveGitDirs(await realpath(worktree));

			expect(targets).toHaveLength(1);
			expect(targets[0].gitDir).toBe(path.join(root, '.git', 'worktrees', path.basename(worktree)));
			expect(targets[0].commonDir).toBe(path.join(root, '.git'));
			// The two differ — which is exactly why both have to be watched.
			expect(targets[0].gitDir).not.toBe(targets[0].commonDir);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	test('includes each nested sub-repo alongside the project repo', async () => {
		await initRepo(root);
		await commitSomething(root);
		const nested = path.join(root, 'sdks', 'php');
		await initRepo(nested);
		await commitSomething(nested, 'README.md');

		const targets = await resolveGitDirs(root);
		const byRepoPath = new Map(targets.map((target) => [target.repoPath, target]));

		expect(byRepoPath.has(root)).toBe(true);
		expect(byRepoPath.has(nested)).toBe(true);
		expect(byRepoPath.get(nested)!.gitDir).toBe(path.join(nested, '.git'));
	});

	test('resolves a submodule to its git dir inside the superproject', async () => {
		// A submodule's `.git` is a FILE pointing at `<super>/.git/modules/<name>`.
		const upstream = path.join(root, 'upstream');
		await initRepo(upstream);
		await commitSomething(upstream);

		const superproject = path.join(root, 'super');
		await initRepo(superproject);
		await commitSomething(superproject);
		await git(superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', upstream, 'vendor/lib');
		await git(superproject, 'commit', '-m', 'add submodule');

		const targets = await resolveGitDirs(superproject);
		const submodule = targets.find((target) => target.repoPath === path.join(superproject, 'vendor', 'lib'));

		expect(submodule).toBeDefined();
		expect(submodule!.gitDir).toBe(path.join(superproject, '.git', 'modules', 'vendor', 'lib'));
	});
});
