import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from '../../git/git-executor';
import { buildBudgetedStagedDiff, COMMIT_MESSAGE_BUDGET, type DiffBudget } from './diff-budget';

/**
 * The AI generators used to inline the raw `git diff --cached` output, which had
 * no upper bound at all. These assert the replacement stays inside its budget
 * while still describing the whole change.
 */

let repo: string;

async function git(...args: string[]) {
	const result = await execGit(args, repo);
	if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	return result.stdout;
}

const TINY_BUDGET: DiffBudget = {
	perFileBytes: 400,
	totalBytes: 900,
	maxFiles: 3,
	contextLines: 1
};

beforeEach(async () => {
	repo = await mkdtemp(path.join(tmpdir(), 'clopen-diffbudget-'));
	await git('init', '-b', 'main', '.');
	await git('config', 'user.email', 'test@example.com');
	await git('config', 'user.name', 'Test');
	await git('config', 'commit.gpgsign', 'false');
});

afterEach(async () => {
	await rm(repo, { recursive: true, force: true });
});

describe('buildBudgetedStagedDiff', () => {
	test('reports an empty staging area', async () => {
		const result = await buildBudgetedStagedDiff(repo, COMMIT_MESSAGE_BUDGET);
		expect(result.isEmpty).toBe(true);
		expect(result.text).toBe('');
	});

	test('includes the stat header and the patch for a small change', async () => {
		await writeFile(path.join(repo, 'a.ts'), 'export const a = 1;\n');
		await git('add', '-A');

		const result = await buildBudgetedStagedDiff(repo, COMMIT_MESSAGE_BUDGET);
		expect(result.isEmpty).toBe(false);
		expect(result.truncated).toBe(false);
		expect(result.text).toContain('Files changed:');
		expect(result.text).toContain('a.ts');
		expect(result.text).toContain('export const a = 1;');
	});

	test('skips lockfiles and generated output but still names them', async () => {
		await writeFile(path.join(repo, 'bun.lock'), 'x'.repeat(50_000));
		await mkdir(path.join(repo, 'dist'), { recursive: true });
		await writeFile(path.join(repo, 'dist', 'bundle.js'), 'y'.repeat(50_000));
		await writeFile(path.join(repo, 'src.ts'), 'export const keep = true;\n');
		await git('add', '-A');

		const result = await buildBudgetedStagedDiff(repo, COMMIT_MESSAGE_BUDGET);
		expect(result.text).toContain('Binary or generated files (diff omitted)');
		expect(result.text).toContain('bun.lock');
		expect(result.text).toContain('dist/bundle.js');
		// The real source file still gets its patch.
		expect(result.text).toContain('export const keep = true;');
		// And none of the 100 KB of noise made it into the prompt.
		expect(result.text).not.toContain('x'.repeat(200));
		expect(result.text).not.toContain('y'.repeat(200));
	});

	test('omits a binary file from the patch body', async () => {
		await writeFile(path.join(repo, 'image.dat'), Buffer.from([0, 1, 2, 0, 255, 0]));
		await git('add', '-A');

		const result = await buildBudgetedStagedDiff(repo, COMMIT_MESSAGE_BUDGET);
		expect(result.text).toContain('Binary or generated files (diff omitted)');
		expect(result.text).toContain('image.dat');
	});

	test('clips an oversized file and says so', async () => {
		const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');
		await writeFile(path.join(repo, 'big.ts'), `${big}\n`);
		await git('add', '-A');

		const result = await buildBudgetedStagedDiff(repo, TINY_BUDGET);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain('… truncated');
		expect(result.text).toContain('sampled');
		// The whole point: the prompt stays near the budget, not the file size.
		expect(result.text.length).toBeLessThan(TINY_BUDGET.totalBytes * 3);
	});

	test('stops opening files once the budget is spent, and reports the remainder', async () => {
		for (let i = 0; i < 8; i++) {
			const body = Array.from({ length: 60 }, (_, n) => `const v${i}_${n} = ${n};`).join('\n');
			await writeFile(path.join(repo, `f${i}.ts`), `${body}\n`);
		}
		await git('add', '-A');

		const result = await buildBudgetedStagedDiff(repo, TINY_BUDGET);
		expect(result.truncated).toBe(true);
		expect(result.text).toContain('were omitted');
		// Every file is still visible in the stat header, so the model can
		// describe the change as a whole.
		expect(result.text).toContain('f7.ts');
	});

	test('handles a rename without losing the path', async () => {
		await writeFile(path.join(repo, 'old.ts'), 'export const x = 1;\n');
		await git('add', '-A');
		await git('commit', '-m', 'init');
		await git('mv', 'old.ts', 'new.ts');

		const result = await buildBudgetedStagedDiff(repo, COMMIT_MESSAGE_BUDGET);
		expect(result.isEmpty).toBe(false);
		expect(result.text).toContain('new.ts');
	});
});
