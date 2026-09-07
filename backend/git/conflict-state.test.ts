import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { gitService } from './git-service';
import { parseConflictMarkers, parseReflog, parseUnmergedStages } from './git-parser';

/**
 * Covers the conflict states the panel used to mishandle: paths with no working
 * -tree file (which were silently dropped), binary conflicts (decoded as UTF-8),
 * and in-progress operations that had no "continue" at all.
 */

let repo: string;

async function git(...args: string[]) {
	return execGit(args, repo);
}

async function gitOk(...args: string[]) {
	const result = await git(...args);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

async function commitAll(message: string) {
	await gitOk('add', '-A');
	await gitOk('commit', '-m', message);
}

beforeEach(async () => {
	repo = await mkdtemp(path.join(tmpdir(), 'clopen-conflict-'));
	await gitOk('init', '-b', 'main', '.');
	await gitOk('config', 'user.email', 'test@example.com');
	await gitOk('config', 'user.name', 'Test');
	await gitOk('config', 'commit.gpgsign', 'false');
	await writeFile(path.join(repo, 'base.txt'), 'base\n');
	await commitAll('init');
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

/** Create a both-modified conflict on `file.txt` by merging `feature` into main. */
async function makeBothModifiedConflict() {
	await writeFile(path.join(repo, 'file.txt'), 'one\ntwo\nthree\n');
	await commitAll('add file');

	await gitOk('checkout', '-b', 'feature');
	await writeFile(path.join(repo, 'file.txt'), 'one\nfeature\nthree\n');
	await commitAll('feature edit');

	await gitOk('checkout', 'main');
	await writeFile(path.join(repo, 'file.txt'), 'one\nmain\nthree\n');
	await commitAll('main edit');

	// Expected to fail with a conflict.
	await git('merge', 'feature');
}

describe('parseConflictMarkers', () => {
	test('parses a plain conflict', () => {
		const markers = parseConflictMarkers(
			['a', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'b'].join('\n')
		);
		expect(markers).toHaveLength(1);
		expect(markers[0].ourContent).toBe('ours');
		expect(markers[0].theirContent).toBe('theirs');
		expect(markers[0].ourStart).toBe(1);
	});

	test('captures the merge base from diff3-style markers', () => {
		const markers = parseConflictMarkers(
			[
				'<<<<<<< HEAD',
				'ours',
				'||||||| base',
				'original',
				'=======',
				'theirs',
				'>>>>>>> feature'
			].join('\n')
		);
		expect(markers[0].baseContent).toBe('original');
		expect(markers[0].ourContent).toBe('ours');
	});

	test('ignores dividers that merely start with the same character', () => {
		// Eight arrows is an ASCII divider, not a marker. The old `startsWith`
		// check treated it as one and reported a phantom conflict.
		const markers = parseConflictMarkers(
			['<<<<<<<<<<<<<<<<', 'text', '================', 'more', '>>>>>>>>>>>>>>>>'].join('\n')
		);
		expect(markers).toHaveLength(0);
	});

	test('ignores an opener with no separator', () => {
		expect(parseConflictMarkers(['<<<<<<< HEAD', 'orphan', 'text'].join('\n'))).toHaveLength(0);
	});

	test('recovers when a second opener appears before the first closes', () => {
		const markers = parseConflictMarkers(
			[
				'<<<<<<< stray',
				'noise',
				'<<<<<<< HEAD',
				'ours',
				'=======',
				'theirs',
				'>>>>>>> feature'
			].join('\n')
		);
		expect(markers).toHaveLength(1);
		expect(markers[0].ourContent).toBe('ours');
	});
});

describe('parseUnmergedStages', () => {
	test('groups stages per path', () => {
		// `\x00`, not `\0`: in a JS string `\0` followed by a digit is a legacy
		// octal escape, so `\0100644` would be one character, not NUL + "100644".
		const output = [
			'100644 aaa 1\tsrc/a.ts',
			'100644 bbb 2\tsrc/a.ts',
			'100644 ccc 3\tsrc/a.ts',
			'100644 ddd 3\tsrc/b.ts',
			''
		].join('\x00');
		const stages = parseUnmergedStages(output);
		expect([...(stages.get('src/a.ts') ?? [])].sort()).toEqual([1, 2, 3]);
		expect([...(stages.get('src/b.ts') ?? [])]).toEqual([3]);
	});
});

describe('parseReflog', () => {
	test('splits the action from the subject', () => {
		const entries = parseReflog(
			'abc123|||abc123|||HEAD@{0}|||rebase (finish): returning to refs/heads/main|||2026-01-01T00:00:00Z'
		);
		expect(entries[0].action).toBe('rebase (finish)');
		expect(entries[0].subject).toBe('returning to refs/heads/main');
		expect(entries[0].selector).toBe('HEAD@{0}');
	});

	test('tolerates a subject with no action prefix', () => {
		const entries = parseReflog('abc|||abc|||HEAD@{1}|||something|||2026-01-01T00:00:00Z');
		expect(entries[0].action).toBe('something');
		expect(entries[0].subject).toBe('');
	});
});

describe('getConflictFiles', () => {
	test('reports a both-modified conflict with markers', async () => {
		await makeBothModifiedConflict();

		const conflicts = await gitService.getConflictFiles(repo);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].path).toBe('file.txt');
		expect(conflicts[0].kind).toBe('both-modified');
		expect(conflicts[0].contentOmitted).toBe(false);
		expect(conflicts[0].markers).toHaveLength(1);
	});

	test('keeps a delete/modify conflict instead of dropping it', async () => {
		await writeFile(path.join(repo, 'gone.txt'), 'content\n');
		await commitAll('add gone');

		await gitOk('checkout', '-b', 'feature');
		await writeFile(path.join(repo, 'gone.txt'), 'changed\n');
		await commitAll('modify');

		await gitOk('checkout', 'main');
		await unlink(path.join(repo, 'gone.txt'));
		await commitAll('delete');

		await git('merge', 'feature');

		const conflicts = await gitService.getConflictFiles(repo);
		expect(conflicts.map(c => c.path)).toContain('gone.txt');
		// Deleted on our side, modified on theirs — no markers to walk.
		expect(conflicts[0].kind).toBe('deleted-by-us');
		expect(conflicts[0].markers).toHaveLength(0);
	});

	test('flags a binary conflict rather than decoding it as text', async () => {
		const binary = (a: number) => Buffer.from([0x00, 0x01, a, 0xff, 0x00]);
		await writeFile(path.join(repo, 'blob.bin'), binary(0x10));
		await commitAll('add blob');

		await gitOk('checkout', '-b', 'feature');
		await writeFile(path.join(repo, 'blob.bin'), binary(0x20));
		await commitAll('feature blob');

		await gitOk('checkout', 'main');
		await writeFile(path.join(repo, 'blob.bin'), binary(0x30));
		await commitAll('main blob');

		await git('merge', 'feature');

		const conflicts = await gitService.getConflictFiles(repo);
		const blob = conflicts.find(c => c.path === 'blob.bin');
		expect(blob).toBeDefined();
		expect(blob?.contentOmitted).toBe(true);
		expect(blob?.omitReason).toBe('binary');
		expect(blob?.content).toBe('');
	});
});

describe('resolveConflict', () => {
	test('refuses to stage content that still has markers', async () => {
		await makeBothModifiedConflict();
		const withMarkers = await readFile(path.join(repo, 'file.txt'), 'utf-8');

		await expect(
			gitService.resolveConflict(repo, 'file.txt', 'custom', withMarkers)
		).rejects.toThrow(/conflict markers/i);

		// Still unmerged — the guard must not half-apply.
		expect(await gitService.getUnmergedPaths(repo)).toEqual(['file.txt']);
	});

	test('"ours" takes our side and stages it', async () => {
		await makeBothModifiedConflict();
		await gitService.resolveConflict(repo, 'file.txt', 'ours');

		expect(await readFile(path.join(repo, 'file.txt'), 'utf-8')).toBe('one\nmain\nthree\n');
		expect(await gitService.getUnmergedPaths(repo)).toEqual([]);
	});

	test('"ours" resolves as a deletion when our side deleted the path', async () => {
		await writeFile(path.join(repo, 'gone.txt'), 'content\n');
		await commitAll('add gone');
		await gitOk('checkout', '-b', 'feature');
		await writeFile(path.join(repo, 'gone.txt'), 'changed\n');
		await commitAll('modify');
		await gitOk('checkout', 'main');
		await unlink(path.join(repo, 'gone.txt'));
		await commitAll('delete');
		await git('merge', 'feature');

		// `git checkout --ours` cannot work here; the answer git wants is `rm`.
		await gitService.resolveConflict(repo, 'gone.txt', 'ours');
		expect(await gitService.getUnmergedPaths(repo)).toEqual([]);
	});

	test('"reset" puts the markers back', async () => {
		await makeBothModifiedConflict();
		await writeFile(path.join(repo, 'file.txt'), 'one\nresolved\nthree\n');
		await gitService.resolveConflict(repo, 'file.txt', 'reset');

		const restored = await readFile(path.join(repo, 'file.txt'), 'utf-8');
		expect(restored).toContain('<<<<<<<');
		expect(await gitService.getUnmergedPaths(repo)).toEqual(['file.txt']);
	});
});

describe('stageAll', () => {
	test('refuses while a conflicted file still has markers', async () => {
		await makeBothModifiedConflict();
		await expect(gitService.stageAll(repo)).rejects.toThrow(/conflict markers/i);
	});

	test('proceeds once the markers are gone', async () => {
		await makeBothModifiedConflict();
		await writeFile(path.join(repo, 'file.txt'), 'one\nresolved\nthree\n');
		await gitService.stageAll(repo);
		expect(await gitService.getUnmergedPaths(repo)).toEqual([]);
	});
});

describe('getOperationState', () => {
	test('is idle in a clean repo', async () => {
		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBeNull();
		expect(state.canContinue).toBe(false);
		expect(state.unmergedCount).toBe(0);
	});

	test('describes a merge and names both sides', async () => {
		await makeBothModifiedConflict();

		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBe('merge');
		expect(state.oursLabel).toBe('main');
		expect(state.theirsLabel).toBe('feature');
		expect(state.unmergedCount).toBe(1);
		// Blocked until the conflict is staged.
		expect(state.canContinue).toBe(false);
	});

	test('allows continue once every path is resolved', async () => {
		await makeBothModifiedConflict();
		await gitService.resolveConflict(repo, 'file.txt', 'ours');

		const state = await gitService.getOperationState(repo);
		expect(state.canContinue).toBe(true);
	});

	test('reports rebase progress with the sides inverted', async () => {
		await writeFile(path.join(repo, 'file.txt'), 'one\ntwo\n');
		await commitAll('add file');

		await gitOk('checkout', '-b', 'feature');
		await writeFile(path.join(repo, 'file.txt'), 'one\nfeature\n');
		await commitAll('feature edit');

		await gitOk('checkout', 'main');
		await writeFile(path.join(repo, 'file.txt'), 'one\nmain\n');
		await commitAll('main edit');

		await gitOk('checkout', 'feature');
		await git('rebase', 'main');

		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBe('rebase');
		// During a rebase "ours" is the branch being rebased ONTO.
		expect(state.oursLabel).toBe('main');
		expect(state.theirsLabel).toContain('feature');
		expect(state.canSkip).toBe(true);
		expect(state.total).toBe(1);
	});

	test('flags unmerged paths with no sentinel as a stash conflict', async () => {
		await writeFile(path.join(repo, 'file.txt'), 'one\n');
		await commitAll('add file');

		await writeFile(path.join(repo, 'file.txt'), 'stashed\n');
		await gitOk('stash', 'push', '-m', 'wip');
		await writeFile(path.join(repo, 'file.txt'), 'other\n');
		await commitAll('conflicting edit');
		await git('stash', 'pop');

		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBeNull();
		expect(state.stashConflict).toBe(true);
		expect(state.unmergedCount).toBeGreaterThan(0);
	});
});

describe('continueOperation', () => {
	test('refuses while paths are still unmerged', async () => {
		await makeBothModifiedConflict();
		await expect(gitService.continueOperation(repo)).rejects.toThrow(/still unmerged/i);
	});

	test('finishes a merge once the conflict is staged', async () => {
		await makeBothModifiedConflict();
		await gitService.resolveConflict(repo, 'file.txt', 'ours');

		const result = await gitService.continueOperation(repo);
		expect(result.success).toBe(true);

		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBeNull();
	});

	test('finishes a rebase, leaving the branch on top of the upstream', async () => {
		await writeFile(path.join(repo, 'file.txt'), 'one\ntwo\n');
		await commitAll('add file');
		await gitOk('checkout', '-b', 'feature');
		await writeFile(path.join(repo, 'file.txt'), 'one\nfeature\n');
		await commitAll('feature edit');
		await gitOk('checkout', 'main');
		await writeFile(path.join(repo, 'file.txt'), 'one\nmain\n');
		await commitAll('main edit');
		await gitOk('checkout', 'feature');
		await git('rebase', 'main');

		await gitService.resolveConflict(repo, 'file.txt', 'theirs');
		const result = await gitService.continueOperation(repo);
		expect(result.success).toBe(true);

		const state = await gitService.getOperationState(repo);
		expect(state.operation).toBeNull();
		const branch = (await gitOk('branch', '--show-current')).trim();
		expect(branch).toBe('feature');
	});

	test('reports there is nothing to continue', async () => {
		await expect(gitService.continueOperation(repo)).rejects.toThrow(/no operation/i);
	});
});

describe('getReflog', () => {
	test('lists recent HEAD movements', async () => {
		await writeFile(path.join(repo, 'a.txt'), 'a\n');
		await commitAll('second');

		const entries = await gitService.getReflog(repo, 10);
		expect(entries.length).toBeGreaterThan(0);
		expect(entries[0].selector).toBe('HEAD@{0}');
		expect(entries[0].action).toContain('commit');
	});
});
