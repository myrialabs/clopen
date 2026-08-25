/**
 * Guards against a module being shadowed by a file an *older* release left behind.
 *
 * Package upgrades are not guaranteed to be clean. On Windows, `bun add -g` has
 * been observed to overlay the new version onto the old install instead of
 * replacing it, so a file that a previous release shipped can still be sitting
 * on disk long after we deleted it from the repo.
 *
 * That is harmless until a deleted file's path is reused as a directory. Import
 * resolution tries `./x.ts` before `./x/index.ts`, so `import … from './x'`
 * silently binds to the leftover — and the user gets a SyntaxError naming a file
 * that does not exist in the version they installed. v0.4.23 shipped exactly
 * this: `browser-automation/actions.ts` became `browser-automation/actions/`,
 * and anyone upgrading from ≤0.4.21 on Windows could not start Clopen at all.
 *
 * The fix in that case is to import the index explicitly (`./actions/index`),
 * which no leftover file can shadow. This test finds the next one for us.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');

/** Directories we ship and therefore import from. */
const sourceRoots = ['backend', 'shared', 'frontend', 'bin', 'scripts'];

const aliases: Record<string, string> = {
	$backend: 'backend',
	$shared: 'shared',
	$frontend: 'frontend'
};

const git = (...args: string[]) =>
	Bun.spawnSync(['git', ...args], { cwd: repoRoot }).stdout.toString();

/**
 * Every path git has ever seen deleted, which is the set of files that can be
 * lingering in somebody's install. Needs full history — a shallow clone only
 * knows about the last commit, so the answer would be a vacuous "none".
 */
const deletedPaths = (): string[] =>
	git('log', '--all', '--diff-filter=D', '--name-only', '--format=')
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean);

const isDirectory = (path: string) => existsSync(path) && statSync(path).isDirectory();

/**
 * A directory is shadowable when some earlier release shipped a file at the
 * same path plus an extension, e.g. `actions/` against a deleted `actions.ts`.
 */
const shadowableDirectories = (): Map<string, string> => {
	const found = new Map<string, string>();

	for (const path of deletedPaths()) {
		const extension = extname(path);
		if (!extension) continue;

		const stem = path.slice(0, -extension.length);
		const absolute = join(repoRoot, stem);

		// Re-added under the same name? Then it is a file again, not a shadow.
		if (existsSync(join(repoRoot, path))) continue;
		if (!isDirectory(absolute)) continue;

		found.set(stem, path);
	}

	return found;
};

const sourceFiles = async (): Promise<string[]> => {
	const glob = new Bun.Glob('**/*.{ts,js,svelte,svelte.ts}');
	const files: string[] = [];

	for (const root of sourceRoots) {
		if (!isDirectory(join(repoRoot, root))) continue;
		for await (const file of glob.scan({ cwd: join(repoRoot, root), absolute: true })) {
			files.push(file);
		}
	}

	return files;
};

const SPECIFIER = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/** Resolves a specifier to a repo-relative path, or null if it points elsewhere. */
const resolveSpecifier = (specifier: string, fromFile: string): string | null => {
	if (specifier.startsWith('.')) {
		return relative(repoRoot, resolve(dirname(fromFile), specifier));
	}

	const [head, ...rest] = specifier.split('/');
	const aliased = aliases[head];
	if (!aliased) return null;

	return normalize(join(aliased, ...rest));
};

describe('module shadowing', () => {
	test('no import can be captured by a file a previous release left behind', async () => {
		if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
			// CI checks out with fetch-depth: 0 so this only skips on shallow clones.
			return;
		}

		const shadowable = shadowableDirectories();
		if (shadowable.size === 0) return;

		const violations: string[] = [];

		for (const file of await sourceFiles()) {
			const contents = await Bun.file(file).text();

			for (const [, specifier] of contents.matchAll(SPECIFIER)) {
				const target = resolveSpecifier(specifier, file);
				if (!target) continue;

				const shadowedBy = shadowable.get(target);
				if (!shadowedBy) continue;

				violations.push(
					`${relative(repoRoot, file)}: '${specifier}' resolves to ${target}/, ` +
						`which a stale ${shadowedBy} would shadow — import '${specifier}/index' instead`
				);
			}
		}

		expect(violations).toEqual([]);
	});
});
