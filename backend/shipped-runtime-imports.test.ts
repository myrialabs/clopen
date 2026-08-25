/**
 * Shipped-runtime import integrity
 *
 * Clopen publishes its backend as SOURCE (see package.json "files": bin,
 * backend, shared, scripts/start.ts) and Bun executes it straight off disk on
 * the user's machine. That machine has only what `dependencies` pulls in —
 * `devDependencies` (every engine SDK, plus the build/lint toolchain) are never
 * installed there.
 *
 * So a runtime import of a devDependency resolves fine in this repo and passes
 * check / lint / test / build / dev, yet crashes every end user at boot:
 *
 *   error: Cannot find module '@earendil-works/pi-ai' from '…/adapters/pi/stream.ts'
 *
 * The failure has no local signal, which is what makes it recur. This test
 * supplies that signal by walking the module graph exactly as the published
 * package would be resolved, and asserting every runtime specifier is reachable
 * there. It covers three ways the shipped tree can break:
 *
 *   1. importing a devDependency (engine SDKs must go through `loadEngineSdk`,
 *      which resolves them from the managed stack dir at runtime),
 *   2. importing a package that is not declared in `dependencies` at all,
 *   3. importing a file that "files" does not ship (e.g. reaching into
 *      `frontend/`, or a path that only exists in the repo).
 *
 * Imports are extracted with `Bun.Transpiler.scanImports`, the same transpiler
 * that runs the code — type-only imports (`import type`, inline `type`
 * specifiers, `typeof import(...)`) are erased by both, so the test sees
 * precisely the specifiers the runtime will try to resolve. That also covers
 * `await import(...)`, which the ESLint guard in eslint.config.js cannot see.
 *
 * Scope is deliberately our own shipped source, not the whole dependency tree.
 * Third-party packages legitimately ship unresolvable specifiers behind guards —
 * ssh2 does `try { require('cpu-features') } catch {}`, cosmiconfig lazily
 * requires `typescript` only when a `.ts` config file exists — which the runtime
 * handles and no static walk can distinguish from a real break.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve, sep } from 'node:path';
import { builtinModules } from 'node:module';

const REPO_ROOT = resolve(import.meta.dir, '..');

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
	files: string[];
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
};

const dependencies = new Set(Object.keys(pkg.dependencies ?? {}));
const devDependencies = new Set(Object.keys(pkg.devDependencies ?? {}));
const builtins = new Set(builtinModules);

/**
 * "files" entries that are build output or config rather than source we can
 * meaningfully walk. `dist` is the vite bundle — self-contained, and absent
 * until `bun run build`.
 */
const NOT_SOURCE = new Set(['dist', 'tsconfig.json', 'bunfig.toml', '.env.example']);

/** tsconfig path aliases, restricted to the ones shipped code may use. */
const ALIASES: Record<string, string> = {
	$backend: 'backend',
	$shared: 'shared',
	$frontend: 'frontend',
};

const SOURCE_EXTENSIONS = ['.ts', '.js'];
const RESOLVE_SUFFIXES = ['', '.ts', '.js', '.json', '/index.ts', '/index.js'];

function walk(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path, out);
		else if (entry.isFile()) out.push(path);
	}
}

/** Every file the published tarball contains, as repo-relative paths. */
function shippedFiles(): Set<string> {
	const files: string[] = [];
	for (const entry of pkg.files) {
		if (NOT_SOURCE.has(entry)) continue;
		const path = join(REPO_ROOT, entry);
		if (!existsSync(path)) continue;
		if (statSync(path).isDirectory()) walk(path, files);
		else files.push(path);
	}
	return new Set(files.map(f => relative(REPO_ROOT, f)));
}

const shipped = shippedFiles();

/**
 * Shipped source files that actually execute for a user. Test files are shipped
 * but never run there, and they legitimately reach for devDependencies.
 */
const filesToCheck = [...shipped]
	.filter(f => SOURCE_EXTENSIONS.some(ext => f.endsWith(ext)))
	.filter(f => !f.endsWith('.test.ts') && !f.endsWith('.test.js'))
	.sort();

/** Root package name of a bare specifier ('@scope/pkg/sub' → '@scope/pkg'). */
function packageRoot(specifier: string): string {
	const parts = specifier.split('/');
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/** Repo-relative path a local specifier resolves to, or null when unresolvable. */
function resolveLocal(fromFile: string, target: string): string | null {
	// A ".js" specifier is the bundler-style spelling of a ".ts" sibling — Bun
	// rewrites it, so the same candidate must be tried here.
	const targets = target.endsWith('.js') ? [target, `${target.slice(0, -3)}.ts`] : [target];

	for (const candidateTarget of targets) {
		for (const suffix of RESOLVE_SUFFIXES) {
			const candidate = resolve(REPO_ROOT, dirname(fromFile), candidateTarget + suffix);
			if (existsSync(candidate) && statSync(candidate).isFile()) {
				return relative(REPO_ROOT, candidate);
			}
		}
	}
	return null;
}

interface Violation {
	file: string;
	specifier: string;
	kind: string;
	problem: string;
}

function inspect(file: string): Violation[] {
	const transpiler = new Bun.Transpiler({ loader: file.endsWith('.js') ? 'js' : 'ts' });
	const violations: Violation[] = [];

	// The transpiler rejects a shebang line, which the CLI entrypoints carry.
	const source = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/^#!.*/, '');

	for (const { path: specifier, kind } of transpiler.scanImports(source)) {
		const report = (problem: string) => violations.push({ file, specifier, kind, problem });

		// Aliased ($backend/…) and relative specifiers must land on a shipped file.
		const aliasRoot = specifier.split('/')[0]!;
		const aliasTarget = ALIASES[aliasRoot];
		const local = aliasTarget !== undefined
			? resolveLocal('.', `./${[aliasTarget, ...specifier.split('/').slice(1)].join('/')}`)
			: specifier.startsWith('.') ? resolveLocal(file, specifier) : undefined;

		if (local !== undefined) {
			if (local === null) report('does not resolve to any file in the repo');
			else if (!shipped.has(local)) {
				report(`resolves to "${local}", which package.json "files" does not ship`);
			}
			continue;
		}

		if (specifier.startsWith('node:') || specifier.startsWith('bun:')) continue;
		if (builtins.has(packageRoot(specifier))) continue;

		const root = packageRoot(specifier);
		if (dependencies.has(root)) continue;
		if (devDependencies.has(root)) {
			report(
				`"${root}" is a devDependency, so it is absent on an end user's install — ` +
				'import it with `import type`, or load it at runtime via loadEngineSdk()'
			);
			continue;
		}
		report(`"${root}" is not declared in package.json dependencies`);
	}

	return violations;
}

describe('shipped runtime', () => {
	test('ships a non-trivial number of source files', () => {
		// Guards the walk itself: a bad "files" read would otherwise make every
		// assertion below pass vacuously.
		expect(filesToCheck.length).toBeGreaterThan(100);
		expect(filesToCheck.some(f => f.startsWith(`backend${sep}`))).toBe(true);
	});

	test('every runtime import resolves on an end user install', () => {
		const violations = filesToCheck.flatMap(inspect);
		const report = violations
			.map(v => `  ${v.file}\n    ${v.kind} "${v.specifier}" — ${v.problem}`)
			.join('\n');
		expect(report).toBe('');
	});

	test('detects a devDependency import (the guard itself works)', () => {
		// The bug this suite exists to prevent, reproduced in-memory: if this ever
		// stops being reported, the check above has silently gone blind.
		const transpiler = new Bun.Transpiler({ loader: 'ts' });
		const offending = "import { clampThinkingLevel } from '@earendil-works/pi-ai';\n" +
			'export const level = clampThinkingLevel;\n';
		const scanned = transpiler.scanImports(offending);

		expect(scanned.map(s => s.path)).toContain('@earendil-works/pi-ai');
		expect(devDependencies.has('@earendil-works/pi-ai')).toBe(true);
		expect(dependencies.has('@earendil-works/pi-ai')).toBe(false);
	});

	test('type-only imports are erased, so they are never flagged', () => {
		const transpiler = new Bun.Transpiler({ loader: 'ts' });
		const typeOnly = [
			"import type { Model } from '@earendil-works/pi-ai';",
			"import { type Api } from '@earendil-works/pi-ai';",
			"type Sdk = typeof import('@earendil-works/pi-coding-agent');",
			"type Snip = import('svelte').Snippet;",
			'export type { Model, Api, Sdk, Snip };',
		].join('\n');

		expect(transpiler.scanImports(typeOnly)).toEqual([]);
	});

	test('runtime dynamic imports are seen (ESLint alone cannot see these)', () => {
		const transpiler = new Bun.Transpiler({ loader: 'ts' });
		const dynamic = "export const load = () => import('@github/copilot-sdk');\n";

		expect(transpiler.scanImports(dynamic)).toEqual([
			{ kind: 'dynamic-import', path: '@github/copilot-sdk' },
		]);
	});
});
