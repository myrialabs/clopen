import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execGit } from './git-executor';
import {
	beginWatchedDiscovery,
	clearNestedRepoCache,
	endWatchedDiscovery,
	findNestedRepoPaths,
	findRepoForFile,
	invalidateRepoSet,
	notifyPathChanged
} from './nested-repos';

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
	// The walk is cached for seconds; these tests rebuild a project's layout in
	// milliseconds. Without this a fixture would be asserted against the
	// previous test's tree whenever mkdtemp hands back a reused path.
	clearNestedRepoCache();
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

describe('walk cache', () => {
	// The walk is the expensive half of discovery (readdir over the whole tree
	// plus a `git check-ignore` spawn per level), and the Git panel fires it
	// several times a second: staging triggers `git:status` and `git:branches`,
	// and the `.git` watcher fires `git:changed` right behind them. On Windows
	// each of those spawns is slow enough that the panel visibly froze.

	test('reuses the walk instead of re-scanning the tree', async () => {
		expect(await detected()).toEqual([]);

		// Created after the walk was cached, so it must not be visible yet:
		// this is what proves the second call did not re-scan.
		await initRepo(path.join(root, 'packages/widget'));
		expect(await detected()).toEqual([]);

		clearNestedRepoCache();
		expect(await detected()).toEqual(['packages/widget']);
	});

	test('still reports a cached provisional repo the moment it gains work', async () => {
		// The reason only the walk is cached. A repo inside an ignored tree is
		// held back until it has something to show; if the filtered list were
		// cached too, the sub-repo an agent just wrote into would stay missing
		// from the Changes tab for the rest of the TTL.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual([]);

		await addLocalWork(path.join(root, 'themes/mytheme'));
		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('callers arriving during a walk share it and get their own array', async () => {
		await initRepo(path.join(root, 'packages/widget'));

		const [first, second] = await Promise.all([
			findNestedRepoPaths(root),
			findNestedRepoPaths(root)
		]);

		expect(second).toEqual(first);
		// Separate arrays — `git:status` mutates the list it is handed, and it
		// runs concurrently with `git:branches` on the same root.
		expect(second).not.toBe(first);
	});

	test('scopes clearing to one root', async () => {
		const other = await mkdtemp(path.join(tmpdir(), 'clopen-nested-other-'));
		try {
			await initRepo(other);
			expect(await detected()).toEqual([]);
			await findNestedRepoPaths(other);

			await initRepo(path.join(root, 'packages/widget'));
			await initRepo(path.join(other, 'packages/widget'));

			clearNestedRepoCache(root);
			expect(await detected()).toEqual(['packages/widget']);
			expect(await findNestedRepoPaths(other)).toEqual([]);
		} finally {
			await rm(other, { recursive: true, force: true });
		}
	});
});

describe('watcher-driven discovery', () => {
	// Discovery used to be re-derived on every `git:status` and `git:branches`:
	// an `fs.readdir` over the whole tree, a `git check-ignore` spawn per repo
	// per depth level, then a `git status` spawn per repo inside an ignored
	// tree. The panel fires that three or four times a second while staging,
	// and on Windows every spawn pays for Defender.
	//
	// The file watcher already knows when any of it changes, so it — not a
	// clock — decides when an answer is stale. These tests pin the contract
	// both ways: a watched root reuses answers, and every signal that could
	// change one puts it back.

	/** Count git subcommands spawned while `run` executes. */
	async function countSpawns<T>(run: () => Promise<T>): Promise<{ result: T; spawns: string[] }> {
		const spawns: string[] = [];
		const realSpawn = Bun.spawn;
		// argv is [git, -c, safe.directory=…, <subcommand>, …]
		// @ts-expect-error test instrumentation
		Bun.spawn = (cmd: string[], options: unknown) => {
			if (Array.isArray(cmd) && cmd[3]) spawns.push(cmd[3]);
			// @ts-expect-error passthrough
			return realSpawn(cmd, options);
		};
		try {
			return { result: await run(), spawns };
		} finally {
			Bun.spawn = realSpawn;
		}
	}

	test('a watched root answers a repeat call without touching git at all', async () => {
		// The WordPress shape the detection policy was written for: every plugin
		// is its own repo inside a tree the project ignores, so every one of them
		// needs a `git status` to prove it has something to show. Unwatched, that
		// is a spawn per plugin on every single call.
		await writeFile(path.join(root, '.gitignore'), 'wp-content/plugins/\n');
		for (const name of ['alpha', 'beta', 'gamma']) {
			const plugin = path.join(root, 'wp-content/plugins', name);
			await initRepo(plugin);
			await addLocalWork(plugin);
		}

		beginWatchedDiscovery(root);
		expect(await detected()).toEqual([
			'wp-content/plugins/alpha',
			'wp-content/plugins/beta',
			'wp-content/plugins/gamma'
		]);

		const { result, spawns } = await countSpawns(() => detected());
		expect(result).toEqual([
			'wp-content/plugins/alpha',
			'wp-content/plugins/beta',
			'wp-content/plugins/gamma'
		]);
		expect(spawns).toEqual([]);
	});

	test('an unwatched root keeps probing live, so nothing can hide behind a guess', async () => {
		// No watcher means no signal, and a cached "nothing to show" would hide a
		// sub-repo the user is working in — the worst failure this module has.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await addLocalWork(path.join(root, 'themes/mytheme'));

		expect(await detected()).toEqual(['themes/mytheme']);

		const { spawns } = await countSpawns(() => detected());
		expect(spawns).toContain('status');
	});

	test('a write into a pristine sub-repo puts it back on the list', async () => {
		// The transition the containment matching exists for. While `mytheme` is
		// pristine it is deliberately unreported, so the watcher has never
		// resolved a git dir for it and cannot name it. The only place it is
		// known is the verdict cache holding the `false` that is about to be
		// wrong — which is why invalidation matches by containment.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));

		beginWatchedDiscovery(root);
		expect(await detected()).toEqual([]);

		const edited = path.join(root, 'themes/mytheme/style.css');
		await writeFile(edited, 'body { color: red }\n');
		notifyPathChanged(root, edited);

		expect(await detected()).toEqual(['themes/mytheme']);
	});

	test('a sibling sub-repo keeps its verdict when one of them is written to', async () => {
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		for (const name of ['alpha', 'beta']) {
			const theme = path.join(root, 'themes', name);
			await initRepo(theme);
			await addLocalWork(theme);
		}

		beginWatchedDiscovery(root);
		expect(await detected()).toEqual(['themes/alpha', 'themes/beta']);

		const edited = path.join(root, 'themes/alpha/style.css');
		await writeFile(edited, 'body {}\n');
		notifyPathChanged(root, edited);

		// Only alpha is re-probed; beta answers from its cached verdict.
		const { spawns } = await countSpawns(() => detected());
		expect(spawns.filter((cmd) => cmd === 'status')).toHaveLength(1);
	});

	test('a per-repo exclude file moves the boundary like .gitignore does', async () => {
		// `.git/info/exclude` is obeyed by `git check-ignore` exactly like
		// `.gitignore`, so it decides whether a sub-repo has to prove local work.
		// The watcher deliberately filters it out of the panel's git-state
		// events — the panel has nothing to show for it — so discovery has to
		// recognise it by name rather than ride along with those.
		await initRepo(path.join(root, 'themes/mytheme'));

		beginWatchedDiscovery(root);
		expect(await detected()).toEqual(['themes/mytheme']);

		await mkdir(path.join(root, '.git/info'), { recursive: true });
		const exclude = path.join(root, '.git/info/exclude');
		await writeFile(exclude, 'themes/\n');
		notifyPathChanged(root, exclude);

		// Now inside an ignored tree and pristine, so it drops off the list.
		expect(await detected()).toEqual([]);
	});

	test('a .git appearing is itself a repo-set change', async () => {
		beginWatchedDiscovery(root);
		expect(await detected()).toEqual([]);

		const widget = path.join(root, 'packages/widget');
		await initRepo(widget);
		notifyPathChanged(root, path.join(widget, '.git'));

		expect(await detected()).toEqual(['packages/widget']);
	});

	test('an ordinary write is not treated as a repo-set change', async () => {
		// The counterweight to the rules above: if every path invalidated the
		// walk, the cache would do nothing at all during a build.
		beginWatchedDiscovery(root);
		expect(await detected()).toEqual([]);

		await initRepo(path.join(root, 'packages/widget'));
		const ordinary = path.join(root, 'src/app.ts');
		await mkdir(path.join(root, 'src'), { recursive: true });
		await writeFile(ordinary, 'export {}\n');
		notifyPathChanged(root, ordinary);

		expect(await detected()).toEqual([]);
	});

	test('ignores signals for a root nobody is watching', async () => {
		await initRepo(path.join(root, 'packages/widget'));
		// Never claimed, so there is no cached answer a signal could correct and
		// nothing here should pretend otherwise.
		notifyPathChanged(root, path.join(root, '.gitignore'));
		expect(await detected()).toEqual(['packages/widget']);
	});

	test('two watchers on one root: the first to leave does not revoke the claim', async () => {
		// Two projects can be opened at the same directory. Releasing on the
		// first close would put discovery back on the clock while a perfectly
		// good signal source was still running.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await addLocalWork(path.join(root, 'themes/mytheme'));

		beginWatchedDiscovery(root);
		beginWatchedDiscovery(root);
		expect(await detected()).toEqual(['themes/mytheme']);

		endWatchedDiscovery(root);
		const stillWatched = await countSpawns(() => detected());
		expect(stillWatched.spawns).toEqual([]);

		endWatchedDiscovery(root);
		const released = await countSpawns(() => detected());
		expect(released.spawns).toContain('status');
	});

	test('invalidating the repo set re-walks the tree', async () => {
		beginWatchedDiscovery(root);
		expect(await detected()).toEqual([]);

		await initRepo(path.join(root, 'packages/widget'));
		expect(await detected()).toEqual([]);

		invalidateRepoSet(root);
		expect(await detected()).toEqual(['packages/widget']);
	});

	test('losing the watcher drops every answer it was backing', async () => {
		// Nothing will invalidate from here on, so a verdict kept across this
		// boundary would never be corrected.
		await writeFile(path.join(root, '.gitignore'), 'themes/\n');
		await initRepo(path.join(root, 'themes/mytheme'));
		await addLocalWork(path.join(root, 'themes/mytheme'));

		beginWatchedDiscovery(root);
		expect(await detected()).toEqual(['themes/mytheme']);

		endWatchedDiscovery(root);
		const { spawns } = await countSpawns(() => detected());
		expect(spawns).toContain('check-ignore');
		expect(spawns).toContain('status');
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
