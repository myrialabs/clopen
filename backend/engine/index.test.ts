/**
 * Boot must not load engine adapters.
 *
 * The registry used to import all eight adapters statically, so every user's
 * startup was coupled to every adapter. One of them failing to load — an SDK
 * that isn't installed, a bad module-level expression — killed the whole
 * backend, including for someone who only ever uses Claude. That is how a value
 * import of `@earendil-works/pi-ai` in the Pi adapter turned into "Clopen does
 * not start" for people who had never touched Pi.
 *
 * Adapters are now loaded per engine, on first use. That property is invisible
 * at a glance and easy to undo: one `import { PiEngine } from './adapters/pi'`
 * added for convenience anywhere in the boot path silently restores the old
 * coupling, and nothing would fail until a user's install breaks.
 *
 * So this walks the real thing — the eager import closure of `backend/index.ts`,
 * following static imports only, exactly as the runtime evaluates them — and
 * asserts no adapter's engine class is reachable. Type-only imports are erased
 * by `Bun.Transpiler.scanImports` (the same transpiler that runs the code) and
 * dynamic `import()` is reported separately, so what remains is precisely what
 * boot pays for.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { ENGINES } from '$shared/constants/engines';
import { getEngine, findProjectEngine, getProjectEngine } from './index';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const ENTRYPOINT = 'backend/index.ts';

/**
 * The OpenCode server module holds a process-wide client singleton that
 * shutdown must release, so the registry imports it directly. It deliberately
 * does not pull in the engine class, which is what must stay lazy.
 */
const ADAPTER_DIR = 'backend/engine/adapters';

const ALIASES: Record<string, string> = { $backend: 'backend', $shared: 'shared' };
const SUFFIXES = ['', '.ts', '.js', '/index.ts', '/index.js'];

/** Repo-relative path a local specifier resolves to, or null. */
function resolveLocal(fromFile: string, specifier: string): string | null {
	const aliasRoot = specifier.split('/')[0]!;
	const aliased = ALIASES[aliasRoot];
	const target = aliased !== undefined
		? `./${[aliased, ...specifier.split('/').slice(1)].join('/')}`
		: specifier;
	if (!target.startsWith('.')) return null; // bare package — not our source

	const base = aliased !== undefined ? '.' : fromFile;
	const candidates = target.endsWith('.js') ? [target, `${target.slice(0, -3)}.ts`] : [target];

	for (const candidate of candidates) {
		for (const suffix of SUFFIXES) {
			const absolute = resolve(REPO_ROOT, dirname(base), candidate + suffix);
			if (existsSync(absolute) && statSync(absolute).isFile()) {
				return relative(REPO_ROOT, absolute);
			}
		}
	}
	return null;
}

/** Every repo file the entrypoint pulls in through static imports alone. */
function eagerClosure(entry: string): Set<string> {
	const transpiler = new Bun.Transpiler({ loader: 'ts' });
	const seen = new Set<string>([entry]);
	const queue = [entry];

	while (queue.length) {
		const file = queue.shift()!;
		const source = readFileSync(resolve(REPO_ROOT, file), 'utf8').replace(/^#!.*/, '');

		for (const { path, kind } of transpiler.scanImports(source)) {
			// Only static imports are evaluated at load; dynamic ones are the point.
			if (kind !== 'import-statement') continue;
			const target = resolveLocal(file, path);
			if (!target || seen.has(target)) continue;
			seen.add(target);
			queue.push(target);
		}
	}

	return seen;
}

describe('engine registry', () => {
	const closure = eagerClosure(ENTRYPOINT);

	test('the walk actually reached the backend', () => {
		// Without this, a broken walk would make the assertion below vacuous.
		expect(closure.size).toBeGreaterThan(50);
		expect(closure.has('backend/engine/index.ts')).toBe(true);
	});

	test('booting loads no engine adapter', () => {
		// An adapter's engine class lives in its barrel and its stream module;
		// sibling modules (credential, presets, the OpenCode server singleton) are
		// plain helpers that WS handlers legitimately import at boot.
		const loaded = [...closure]
			.filter(f => f.startsWith(`${ADAPTER_DIR}/`))
			.filter(f => /\/(index|stream)\.ts$/.test(f))
			.sort();

		expect(loaded).toEqual([]);
	});

	test('the registry reaches adapters only through dynamic imports', () => {
		const transpiler = new Bun.Transpiler({ loader: 'ts' });
		const source = readFileSync(resolve(REPO_ROOT, 'backend/engine/index.ts'), 'utf8');
		const imports = transpiler.scanImports(source);

		const eagerAdapters = imports
			.filter(i => i.kind === 'import-statement' && i.path.includes('./adapters/'))
			.map(i => i.path)
			.filter(path => path !== './adapters/opencode/server');
		const lazyAdapters = imports.filter(i => i.kind === 'dynamic-import' && i.path.includes('./adapters/'));

		expect(eagerAdapters).toEqual([]);
		// One loader per engine — a switch back to static imports would empty this.
		expect(lazyAdapters.length).toBe(ENGINES.length);
	});
});

describe('engine loading', () => {
	// Derived from the same list the engine picker renders, so a newly shipped
	// engine is covered here the moment it becomes selectable.
	const engineTypes = ENGINES.map(engine => engine.type);

	test('every engine loads and is wired to its own adapter', async () => {
		// The loader table is eight hand-written lines of `new (await
		// import(…)).XEngine()`. Mapping a key to the wrong class — 'cursor' to
		// ClineEngine — type-checks perfectly and would silently route a user's
		// chat through the wrong SDK. `name` is each adapter's own declaration of
		// what it is, so comparing it against the key catches exactly that.
		const wrong: string[] = [];

		for (const type of engineTypes) {
			const engine = await getEngine(type);
			if (engine.name !== type) wrong.push(`${type} loaded ${engine.constructor.name} (name "${engine.name}")`);
		}

		expect(wrong).toEqual([]);
	});

	test('every engine satisfies the AIEngine contract', async () => {
		const incomplete: string[] = [];

		for (const type of engineTypes) {
			const engine = await getEngine(type);
			const missing = (['initialize', 'dispose', 'getAvailableModels', 'streamQuery'] as const)
				.filter(method => typeof engine[method] !== 'function');
			if (missing.length) incomplete.push(`${type}: missing ${missing.join(', ')}`);
		}

		expect(incomplete).toEqual([]);
	});

	test('concurrent callers share one instance', async () => {
		// Loading is async, so an unshared cache would hand two callers two
		// engines for the same project — split abort controllers, a cancel that
		// cancels nothing.
		const [a, b, c] = await Promise.all([
			getProjectEngine('concurrency-probe', 'claude-code'),
			getProjectEngine('concurrency-probe', 'claude-code'),
			getProjectEngine('concurrency-probe', 'claude-code'),
		]);

		expect(a).toBe(b);
		expect(b).toBe(c);
	});

	test('findProjectEngine never creates an engine', async () => {
		expect(findProjectEngine('find-probe', 'codex')).toBeUndefined();

		const created = await getProjectEngine('find-probe', 'codex');
		expect(findProjectEngine('find-probe', 'codex')).toBe(created);
	});

	test('an unknown engine type is rejected, not silently ignored', async () => {
		// Engine types come from stored settings, so a stale one is reachable.
		expect(getEngine('nope' as never)).rejects.toThrow('Unknown engine type');
	});
});
