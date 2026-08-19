import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { findNestedRepoPaths, findRepoForFile } from './nested-repos';

/**
 * Sub-repo detection used to walk the whole tree and report every directory
 * with a `.git` inside it. On an iOS project that meant Swift Package
 * Manager's `build/…/SourcePackages/checkouts/*` — thousands of foreign
 * changes in the Changes tab. These cover both sides of the policy: package
 * caches stay out, repos the user actually embedded stay in.
 */

let root: string;

async function git(cwd: string, ...args: string[]) {
	const result = await execGit(args, cwd);
	if (result.exitCode !== 0 && args[0] !== 'check-ignore') {
		throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
	}
	return result.stdout;
}

async function initRepo(dir: string) {
	await mkdir(dir, { recursive: true });
	await git(dir, 'init', '-b', 'main', '.');
	await git(dir, 'config', 'user.email', 'test@example.com');
	await git(dir, 'config', 'user.name', 'Test');
	await git(dir, 'config', 'commit.gpgsign', 'false');
}

/** Paths relative to the project root, for readable assertions. */
async function detected(): Promise<string[]> {
	const paths = await findNestedRepoPaths(root);
	return paths.map((p) => path.relative(root, p).replace(/\\/g, '/')).sort();
}

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), 'clopen-nested-'));
	await initRepo(root);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe('findNestedRepoPaths', () => {
	test('ignores package-manager checkouts under an ignored build dir', async () => {
		await writeFile(path.join(root, '.gitignore'), 'build/\n');
		for (const name of ['abseil-cpp-binary', 'firebase-ios-sdk', 'leveldb']) {
			await initRepo(path.join(root, 'build/ios/SourcePackages/checkouts', name));
		}

		expect(await detected()).toEqual([]);
	});

	test('ignores dependency dirs by name even when they are committed', async () => {
		// No .gitignore at all — the name alone must be enough.
		await initRepo(path.join(root, 'node_modules/some-pkg'));
		await initRepo(path.join(root, 'ios/Pods/SomePod'));
		await initRepo(path.join(root, '.build/checkouts/some-dep'));

		expect(await detected()).toEqual([]);
	});

	test('detects a repo embedded in the project tree', async () => {
		await initRepo(path.join(root, 'packages/widget'));

		expect(await detected()).toEqual(['packages/widget']);
	});

	test('detects a repo the outer repo ignores', async () => {
		await writeFile(path.join(root, '.gitignore'), 'wp-content/themes/mytheme/\n');
		await initRepo(path.join(root, 'wp-content/themes/mytheme'));

		expect(await detected()).toEqual(['wp-content/themes/mytheme']);
	});

	test('detects a repo sitting directly under an ignored parent', async () => {
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('does not report repos generated deep inside an ignored tree', async () => {
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await initRepo(path.join(root, 'themes/cache/vendor/dep/checkout'));

		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('a nested repo is judged by its own ignore rules', async () => {
		await initRepo(path.join(root, 'packages/widget'));
		await writeFile(path.join(root, 'packages/widget/.gitignore'), 'build/\n');
		await initRepo(path.join(root, 'packages/widget/build/x/y/dep'));
		await initRepo(path.join(root, 'packages/widget/plugins/helper'));

		expect(await detected()).toEqual(['packages/widget', 'packages/widget/plugins/helper']);
	});
});

describe('findRepoForFile', () => {
	test('routes a file to the deepest owning repo', async () => {
		await initRepo(path.join(root, 'packages/widget'));
		await initRepo(path.join(root, 'packages/widget/plugins/helper'));

		const owner = await findRepoForFile(root, 'packages/widget/plugins/helper/src/a.ts');
		expect(owner?.repoPath).toBe(path.join(root, 'packages/widget/plugins/helper'));
		expect(owner?.relativeFilePath).toBe('src/a.ts');
	});

	test('leaves outer-repo files alone', async () => {
		await initRepo(path.join(root, 'packages/widget'));

		expect(await findRepoForFile(root, 'src/main.ts')).toBeNull();
	});
});
