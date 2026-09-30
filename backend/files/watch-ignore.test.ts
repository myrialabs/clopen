/**
 * Watch ignore policy tests.
 *
 * The negative cases matter as much as the positive ones: a name ignored in
 * the wrong ecosystem hides real source from the explorer (Clopen's own `bin/`
 * is source), and a dot-directory ignored by default is the stale-panel bug
 * this policy replaced.
 */

import { describe, expect, test, afterEach } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	GeneratedDirClassifier,
	isIgnoredName,
	isIgnoredPath,
	isMarkedOutputDir,
	hasGeneratedSignature,
	isOutputMarker,
	isSignatureEntry
} from './watch-ignore';

const tempRoots: string[] = [];

async function makeProject(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'clopen-ignore-'));
	tempRoots.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('isIgnoredPath (by name)', () => {
	test('ignores dependency stores, build output and caches at any depth', () => {
		for (const path of [
			'node_modules/pkg/index.js',
			'packages/web/node_modules/x',
			'.git/HEAD',
			'.venv/lib/site.py',
			'app/.dart_tool/package_config.json',
			'ios/.build/debug',
			'.stack-work/dist',
			'cmake-build-debug/CMakeCache.txt',
			'.zig-cache/o'
		]) {
			expect(isIgnoredPath(path)).toBe(true);
		}
	});

	test('watches dot-directories people and agents edit', () => {
		for (const path of [
			'.agents/skills/demo/SKILL.md',
			'.agents/mcp.json',
			'.claude/settings.json',
			'.github/workflows/ci.yml',
			'.vscode/settings.json',
			'.env.local',
			'.gitignore'
		]) {
			expect(isIgnoredPath(path)).toBe(false);
		}
	});

	test('does not ignore names that are source in some ecosystem', () => {
		for (const name of ['bin', 'obj', 'target', 'out', 'deps', '_build', 'Library', 'Pods', 'env', 'venv']) {
			expect(isIgnoredName(name)).toBe(false);
		}
	});

	test('ignores noise files but not their look-alikes', () => {
		expect(isIgnoredPath('src/.DS_Store')).toBe(true);
		expect(isIgnoredPath('.eslintcache')).toBe(true);
		expect(isIgnoredPath('src/.notes.md.swp')).toBe(true);
		expect(isIgnoredPath('src/notes.swp')).toBe(false);
	});
});

describe('isMarkedOutputDir (by manifest)', () => {
	test('treats an ambiguous name as output only beside its manifest', () => {
		expect(isMarkedOutputDir('target', ['Cargo.toml', 'src'])).toBe(true);
		expect(isMarkedOutputDir('target', ['pom.xml'])).toBe(true);
		expect(isMarkedOutputDir('target', ['package.json'])).toBe(false);

		expect(isMarkedOutputDir('bin', ['App.csproj'])).toBe(true);
		expect(isMarkedOutputDir('obj', ['Lib.fsproj'])).toBe(true);
		expect(isMarkedOutputDir('bin', ['package.json', 'bunfig.toml'])).toBe(false);

		expect(isMarkedOutputDir('_build', ['mix.exs'])).toBe(true);
		expect(isMarkedOutputDir('deps', ['mix.exs'])).toBe(true);
		expect(isMarkedOutputDir('deps', ['package.json'])).toBe(false);

		expect(isMarkedOutputDir('out', ['next.config.mjs'])).toBe(true);
		expect(isMarkedOutputDir('out', ['vite.config.ts'])).toBe(false);

		expect(isMarkedOutputDir('Pods', ['Podfile'])).toBe(true);
		expect(isMarkedOutputDir('Library', ['ProjectSettings', 'Assets'])).toBe(true);
		expect(isMarkedOutputDir('Library', ['Sources'])).toBe(false);
		expect(isMarkedOutputDir('Intermediate', ['Game.uproject'])).toBe(true);
		expect(isMarkedOutputDir('bazel-out', ['MODULE.bazel'])).toBe(true);
	});

	test('knows which entries re-decide their siblings', () => {
		expect(isOutputMarker('Cargo.toml')).toBe(true);
		expect(isOutputMarker('App.csproj')).toBe(true);
		expect(isOutputMarker('README.md')).toBe(false);
	});
});

describe('hasGeneratedSignature (by contents)', () => {
	test('recognises cache dirs and environments whatever they are called', () => {
		expect(hasGeneratedSignature(['CACHEDIR.TAG', 'debug'])).toBe(true);
		expect(hasGeneratedSignature(['bin', 'lib', 'pyvenv.cfg'])).toBe(true);
		expect(hasGeneratedSignature(['conda-meta', 'lib'])).toBe(true);
		expect(hasGeneratedSignature(['index.ts', 'utils'])).toBe(false);
		expect(isSignatureEntry('pyvenv.cfg')).toBe(true);
	});
});

describe('GeneratedDirClassifier', () => {
	test('classifies from the disk by manifest and by signature', async () => {
		const root = await makeProject();
		await writeFile(join(root, 'Cargo.toml'), '[package]');
		await mkdir(join(root, 'target', 'debug'), { recursive: true });
		await mkdir(join(root, 'myenv', 'lib'), { recursive: true });
		await writeFile(join(root, 'myenv', 'pyvenv.cfg'), 'home = /usr/bin');
		await mkdir(join(root, 'bin'), { recursive: true });

		const classifier = new GeneratedDirClassifier(root);
		expect(await classifier.isGenerated(join(root, 'target'))).toBe(true);
		expect(await classifier.isGenerated(join(root, 'myenv'))).toBe(true);
		expect(await classifier.isGenerated(join(root, 'bin'))).toBe(false);
		expect(await classifier.isGenerated(root)).toBe(false);
	});

	test('judges ancestors only, so a new output folder itself is still reported', async () => {
		const root = await makeProject();
		await writeFile(join(root, 'Cargo.toml'), '[package]');
		await mkdir(join(root, 'target', 'debug'), { recursive: true });

		const classifier = new GeneratedDirClassifier(root);
		expect(await classifier.isInsideGenerated('target')).toBe(false);
		expect(await classifier.isInsideGenerated('target/debug/app')).toBe(true);
		expect(await classifier.isInsideGenerated('src/main.rs')).toBe(false);
	});

	test('re-reads the disk once told a manifest or signature moved', async () => {
		const root = await makeProject();
		await mkdir(join(root, 'bin'), { recursive: true });
		await mkdir(join(root, 'env'), { recursive: true });

		const classifier = new GeneratedDirClassifier(root);
		expect(await classifier.isGenerated(join(root, 'bin'))).toBe(false);
		expect(await classifier.isGenerated(join(root, 'env'))).toBe(false);

		await writeFile(join(root, 'Tool.csproj'), '<Project />');
		await writeFile(join(root, 'env', 'pyvenv.cfg'), 'home = /usr/bin');
		// Cached until told otherwise…
		expect(await classifier.isGenerated(join(root, 'bin'))).toBe(false);

		classifier.forgetMarkableChildren(root);
		classifier.forget(join(root, 'env'));
		expect(await classifier.isGenerated(join(root, 'bin'))).toBe(true);
		expect(await classifier.isGenerated(join(root, 'env'))).toBe(true);
	});

	test('forgets a removed directory and everything under it', async () => {
		const root = await makeProject();
		await mkdir(join(root, 'env', 'lib'), { recursive: true });
		await writeFile(join(root, 'env', 'pyvenv.cfg'), 'home = /usr/bin');

		const classifier = new GeneratedDirClassifier(root);
		expect(await classifier.isGenerated(join(root, 'env'))).toBe(true);

		await rm(join(root, 'env'), { recursive: true, force: true });
		await mkdir(join(root, 'env'), { recursive: true });
		classifier.forgetTree(join(root, 'env'));
		expect(await classifier.isGenerated(join(root, 'env'))).toBe(false);
	});
});
