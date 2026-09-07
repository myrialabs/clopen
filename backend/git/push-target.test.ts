import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { gitService } from './git-service';

/**
 * Reviewing a pull request from a fork is the case that broke.
 *
 * `gh pr checkout` records the contributor's repository in
 * `branch.<name>.remote` — often as a bare URL — and their branch name in
 * `branch.<name>.merge`. The panel ignored both and ran
 * `git push <selectedRemote> <localName> -u`, which pushed the review commits
 * into the maintainer's own repository as a new branch and then rewrote the
 * branch's remote so every later push went there too.
 */

let workspace: string;
/** Bare repo standing in for the maintainer's repository. */
let upstream: string;
/** Bare repo standing in for the contributor's fork. */
let fork: string;
/** Working clone, with `origin` pointing at `upstream`. */
let work: string;

async function git(cwd: string, ...args: string[]) {
	const result = await execGit(args, cwd);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

async function branchesOf(bareRepo: string): Promise<string[]> {
	const out = await git(bareRepo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/');
	return out.split('\n').map(l => l.trim()).filter(Boolean).sort();
}

async function identify(repo: string) {
	await git(repo, 'config', 'user.email', 'test@example.com');
	await git(repo, 'config', 'user.name', 'Test');
	await git(repo, 'config', 'commit.gpgsign', 'false');
}

beforeEach(async () => {
	workspace = await mkdtemp(path.join(tmpdir(), 'clopen-push-'));
	upstream = path.join(workspace, 'upstream.git');
	fork = path.join(workspace, 'fork.git');
	work = path.join(workspace, 'work');

	await git(workspace, 'init', '--bare', '-b', 'main', upstream);

	// Seed `main` in the upstream repo.
	const seed = path.join(workspace, 'seed');
	await git(workspace, 'clone', '-q', upstream, seed);
	await identify(seed);
	await writeFile(path.join(seed, 'a.txt'), 'a\n');
	await git(seed, 'add', '-A');
	await git(seed, 'commit', '-m', 'init');
	await git(seed, 'push', 'origin', 'main');

	// The fork starts as a copy of upstream and gains the contributor's branch.
	await git(workspace, 'clone', '--bare', '-q', upstream, fork);
	const forkWork = path.join(workspace, 'forkwork');
	await git(workspace, 'clone', '-q', fork, forkWork);
	await identify(forkWork);
	await git(forkWork, 'checkout', '-b', 'their-branch');
	await writeFile(path.join(forkWork, 'contrib.txt'), 'contribution\n');
	await git(forkWork, 'add', '-A');
	await git(forkWork, 'commit', '-m', 'contribution');
	await git(forkWork, 'push', 'origin', 'their-branch');

	// The maintainer's clone.
	await git(workspace, 'clone', '-q', upstream, work);
	await identify(work);
});

afterEach(async () => {
	await rm(workspace, { recursive: true, force: true });
});

/** Reproduce what `gh pr checkout` leaves behind for a fork PR. */
async function checkoutForkPr(localName = 'their-branch') {
	await git(work, 'fetch', fork, 'their-branch');
	await git(work, 'checkout', '-b', localName, 'FETCH_HEAD');
	await git(work, 'config', `branch.${localName}.remote`, fork);
	await git(work, 'config', `branch.${localName}.merge`, 'refs/heads/their-branch');
}

describe('getPushTarget', () => {
	test('reports no upstream for a fresh local branch', async () => {
		await git(work, 'checkout', '-b', 'brand-new');
		const target = await gitService.getPushTarget(work);
		expect(target.branch).toBe('brand-new');
		expect(target.hasUpstream).toBe(false);
	});

	test('reports the tracking branch of a normal clone', async () => {
		const target = await gitService.getPushTarget(work);
		expect(target.hasUpstream).toBe(true);
		expect(target.remote).toBe('origin');
		expect(target.remoteBranch).toBe('main');
		expect(target.isUrl).toBe(false);
	});

	test('resolves a fork PR to the fork, not to origin', async () => {
		await checkoutForkPr();

		const target = await gitService.getPushTarget(work);
		expect(target.hasUpstream).toBe(true);
		expect(target.remote).toBe(fork);
		expect(target.remoteBranch).toBe('their-branch');
		expect(target.isUrl).toBe(true);
	});

	test('keeps the remote branch name when the local branch was renamed', async () => {
		// gh renames the local branch when the name would collide.
		await checkoutForkPr('contributor-their-branch');

		const target = await gitService.getPushTarget(work);
		expect(target.branch).toBe('contributor-their-branch');
		expect(target.remoteBranch).toBe('their-branch');
	});

	test('honours branch.<name>.pushRemote over branch.<name>.remote', async () => {
		await git(work, 'remote', 'add', 'fork', fork);
		await git(work, 'config', 'branch.main.pushRemote', 'fork');

		const target = await gitService.getPushTarget(work);
		expect(target.remote).toBe('fork');
		expect(target.isUrl).toBe(false);
	});
});

describe('push — fork pull request under review', () => {
	test('sends the review commit to the fork and leaves origin untouched', async () => {
		await checkoutForkPr();
		await writeFile(path.join(work, 'review.txt'), 'review fix\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'review fix');

		// `remote` here is what the panel's dropdown would have supplied.
		const result = await gitService.push(work, 'origin', 'their-branch');
		expect(result.success).toBe(true);

		// The fix landed on the contributor's branch...
		const forkHead = await git(fork, 'log', '-1', '--format=%s', 'their-branch');
		expect(forkHead.trim()).toBe('review fix');

		// ...and the maintainer's repository gained nothing.
		expect(await branchesOf(upstream)).toEqual(['main']);
	});

	test('does not rewrite the branch\'s configured remote', async () => {
		await checkoutForkPr();
		await writeFile(path.join(work, 'review.txt'), 'review fix\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'review fix');

		await gitService.push(work, 'origin', 'their-branch');

		// The old `-u` replaced this with "origin", so every later push — including
		// a manual `git push` — silently went to the wrong repository.
		const configured = (await git(work, 'config', '--get', 'branch.their-branch.remote')).trim();
		expect(configured).toBe(fork);
		const merge = (await git(work, 'config', '--get', 'branch.their-branch.merge')).trim();
		expect(merge).toBe('refs/heads/their-branch');
	});

	test('force push targets the fork rather than origin', async () => {
		await checkoutForkPr();
		await writeFile(path.join(work, 'review.txt'), 'review fix\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'review fix');

		const result = await gitService.pushAdvanced(work, 'force', 'origin', 'their-branch');
		expect(result.success).toBe(true);

		const forkHead = await git(fork, 'log', '-1', '--format=%s', 'their-branch');
		expect(forkHead.trim()).toBe('review fix');
		expect(await branchesOf(upstream)).toEqual(['main']);
	});

	test('explains why --force-with-lease cannot work against a URL upstream', async () => {
		await checkoutForkPr();
		await writeFile(path.join(work, 'review.txt'), 'review fix\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'review fix');

		// There is no remote-tracking ref for the lease to compare against, so git
		// refuses with a bare "stale info". Say what that means instead.
		const result = await gitService.pushAdvanced(work, 'force-lease', 'origin', 'their-branch');
		expect(result.success).toBe(false);
		expect(result.message).toMatch(/remote-tracking ref/i);
		expect(await branchesOf(upstream)).toEqual(['main']);
	});
});

describe('push — branch with no upstream', () => {
	test('still creates the branch on the chosen remote and records it', async () => {
		await git(work, 'checkout', '-b', 'feature/new');
		await writeFile(path.join(work, 'f.txt'), 'f\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'new work');

		const result = await gitService.push(work, 'origin', 'feature/new');
		expect(result.success).toBe(true);
		expect(await branchesOf(upstream)).toEqual(['feature/new', 'main']);

		// `-u` is correct here: there was no upstream to overwrite.
		const target = await gitService.getPushTarget(work);
		expect(target.hasUpstream).toBe(true);
		expect(target.remote).toBe('origin');
	});
});

describe('getBranches', () => {
	test('exposes the upstream of a normal tracking branch', async () => {
		const info = await gitService.getBranches(work, 'origin');
		expect(info.local.find(b => b.name === 'main')?.upstream).toBe('origin/main');
	});

	test('exposes a URL upstream that git itself cannot name', async () => {
		await checkoutForkPr();
		const info = await gitService.getBranches(work, 'origin');
		const branch = info.local.find(b => b.name === 'their-branch');
		expect(branch?.upstream).toBe(`${fork}/their-branch`);
	});

	test('counts ahead against the real upstream, not <selected remote>/<name>', async () => {
		await git(work, 'checkout', '-b', 'renamed-locally', 'main');
		await git(work, 'branch', '--set-upstream-to=origin/main', 'renamed-locally');
		await writeFile(path.join(work, 'x.txt'), 'x\n');
		await git(work, 'add', '-A');
		await git(work, 'commit', '-m', 'local work');

		// `origin/renamed-locally` does not exist; the old code compared against it
		// and reported nothing to push.
		const info = await gitService.getBranches(work, 'origin');
		expect(info.ahead).toBe(1);
	});
});

describe('setUpstream / unsetUpstream', () => {
	test('repoints a branch at a different remote branch', async () => {
		await git(work, 'checkout', '-b', 'wip', 'main');
		await gitService.setUpstream(work, 'wip', 'origin', 'main');

		const target = await gitService.getPushTarget(work, 'wip');
		expect(target.remote).toBe('origin');
		expect(target.remoteBranch).toBe('main');
	});

	test('clears tracking so the next push has to choose', async () => {
		await gitService.unsetUpstream(work, 'main');
		const target = await gitService.getPushTarget(work, 'main');
		expect(target.hasUpstream).toBe(false);
	});

	test('reports a remote-tracking ref that does not exist', async () => {
		await expect(gitService.setUpstream(work, 'main', 'origin', 'nope')).rejects.toThrow(
			/could not set upstream/i
		);
	});
});
