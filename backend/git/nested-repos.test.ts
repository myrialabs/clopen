import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import { findNestedRepoPaths, findRepoForFile } from './nested-repos';

/**
 * Sub-repo detection used to walk the whole tree and report every directory
 * with a `.git` inside it — on an iOS project, Swift Package Manager's
 * `build/…/SourcePackages/checkouts/*` put thousands of foreign changes in the
 * Changes tab. Pruning by directory name fixed that case and nothing more:
 * `plugins/` is where tmux clones its packages *and* where a WordPress
 * developer keeps their own plugin repos, so no denylist can be right on both
 * sides. The policy these tests pin down is structural instead — inside a tree
 * the project ignores, a sub-repo is reported only if it holds local work or
 * is a declared submodule.
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

/**
 * Give a repo something the Git panel could show. An untracked file is what an
 * agent writing into a sub-repo produces, and it is what tells a repo the user
 * works in apart from a package manager's pristine checkout.
 */
async function addLocalWork(dir: string) {
	await writeFile(path.join(dir, 'index.php'), '<?php // edited\n');
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

	test('detects a worked-in repo sitting directly under an ignored parent', async () => {
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await addLocalWork(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('leaves a pristine repo under an ignored parent out until it changes', async () => {
		// The deliberate trade-off: with nothing to show, a repo inside an
		// ignored tree is indistinguishable from a package checkout. It comes
		// back the moment there is a change — which is when the panel needs it.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual([]);

		await addLocalWork(path.join(root, 'themes/mytheme'));
		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test.each([
		['elixir mix', '/deps/\n', ['deps/daisyui', 'deps/heroicons']],
		['openwrt feeds', 'feeds/\n', ['feeds/packages', 'feeds/luci']],
		['vim pathogen', 'bundle/\n', ['bundle/vim-fugitive']],
		['tmux tpm', 'plugins/\n', ['plugins/tpm']],
		['ansible galaxy', 'roles/\n', ['roles/geerlingguy.nginx']],
		['puppet librarian', 'modules/\n', ['modules/stdlib']],
		['chef berkshelf', 'berks-cookbooks/\n', ['berks-cookbooks/nginx']],
		['zephyr west', 'west-modules/\n', ['west-modules/hal_stm32']],
		['composer source install', 'vendor/\n', ['vendor/acme/lib']],
		['cmake fetchcontent', 'build/\n', ['build/_deps/googletest-src']]
	])(
		'ignores %s checkouts inside an ignored tree',
		async (_name, gitignore, repos) => {
			// Every one of these clones into an ignored directory, several of
			// them exactly one level down where the peek looks. They are all
			// pristine, which is the only thing the policy needs to know —
			// `plugins/` and `modules/` appear on the user's side of the fence
			// too, so their names cannot be the signal.
			await writeFile(path.join(root, '.gitignore'), gitignore);
			for (const repo of repos) await initRepo(path.join(root, repo));

			expect(await detected()).toEqual([]);
		}
	);

	test('reports the user plugin repo under an ignored dir that tmux also uses', async () => {
		// Same directory name as the tmux case above, opposite verdict.
		await writeFile(path.join(root, '.gitignore'), 'wp-content/plugins/\n');
		await initRepo(path.join(root, 'wp-content/plugins/my-plugin'));
		await addLocalWork(path.join(root, 'wp-content/plugins/my-plugin'));

		expect(await detected()).toEqual(['wp-content/plugins/my-plugin']);
	});

	test('reports a declared submodule inside an ignored tree even when pristine', async () => {
		// `.gitmodules` is the user naming the sub-repo themselves, which
		// outranks anything its working tree could tell us.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await writeFile(
			path.join(root, '.gitmodules'),
			'[submodule "themes/mytheme"]\n\tpath = themes/mytheme\n\turl = https://example.com/t.git\n'
		);
		await initRepo(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('a repo inside a rejected checkout cannot launder itself', async () => {
		// Entering a repo resets the ignore budget, so without inheriting the
		// "inside an ignored tree" flag the vendored repo would be treated as
		// part of `pkg`'s own tracked structure and reported unconditionally.
		await writeFile(path.join(root, '.gitignore'), '/deps/\n');
		const pkg = path.join(root, 'deps/pkg');
		await initRepo(pkg);
		// Committed, so `pkg` itself stays pristine — otherwise the vendored
		// directory would show up as untracked work and this would test nothing.
		await writeFile(path.join(pkg, '.gitignore'), 'vendored/\n');
		await git(pkg, 'add', '-A');
		await git(pkg, 'commit', '-m', 'init');
		await initRepo(path.join(pkg, 'vendored'));

		expect(await detected()).toEqual([]);
	});

	test('still reports an ignored build dir that is itself a repo', async () => {
		// A `dist/` deploy worktree is a repo the user works in; only the
		// contents of a dependency-named dir are off limits, not the dir itself.
		await writeFile(path.join(root, '.gitignore'), 'dist/\n');
		await initRepo(path.join(root, 'dist'));

		expect(await detected()).toEqual(['dist']);
	});

	test('does not report repos generated deep inside an ignored tree', async () => {
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await addLocalWork(path.join(root, 'themes/mytheme'));
		await initRepo(path.join(root, 'themes/cache/vendor/dep/checkout'));
		await addLocalWork(path.join(root, 'themes/cache/vendor/dep/checkout'));

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
