/**
 * What the file watcher ignores.
 *
 * The rule of thumb: ignore what a tool writes and nobody edits by hand —
 * dependency stores, build output, caches, VCS internals — because it is large
 * (on Linux every watched directory costs an inotify handle) and noisy (a build
 * would reload the explorer hundreds of times). Everything else is watched,
 * dot-directories included: `.agents/`, `.claude/`, `.github/` and `.vscode/`
 * hold files people and agents edit, and ignoring every dot path left the
 * explorer stale until a reload.
 *
 * A bare list of names cannot get there on its own: names match at any depth,
 * so a common one (`bin`, `target`, `out`, `Library`) would hide real source in
 * some other ecosystem — Clopen's own `bin/` is source. So there are three
 * layers, and a directory is ignored when any of them matches:
 *
 *  1. Names that mean "generated" wherever they appear ({@link IGNORED_DIRS}).
 *  2. Ambiguous names, ignored only next to the manifest of the ecosystem that
 *     generates them ({@link MARKED_OUTPUT_DIRS}): `target/` beside
 *     `Cargo.toml`, `bin/` beside a `.csproj`.
 *  3. Directories that describe themselves, whatever they are called
 *     ({@link SIGNATURE_ENTRIES}): the cross-tool `CACHEDIR.TAG` standard, and
 *     Python / conda environments.
 *
 * `.gitignore` is deliberately NOT a source. People commonly ignore folders
 * they edit every day — `.claude/`, `.vscode/`, `.agents/`, local config — and
 * pruning by it would bring back exactly the stale-explorer bug this fixes.
 */

import { readdir } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

/** Layer 1: names that are machine-written wherever they appear. */
const IGNORED_DIRS = new Set([
	// Version control internals
	'.git', '.hg', '.svn', '.jj', '.bzr',
	// JavaScript / TypeScript
	'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn',
	'dist', 'build', 'coverage', '.nyc_output',
	'.next', '.nuxt', '.output', '.svelte-kit', '.angular', '.astro', '.expo',
	'.react-router', '.vinxi', '.nitro', '.vite', '.parcel-cache', '.turbo', '.nx',
	'.docusaurus', '.vercel', '.netlify', '.wrangler', '.serverless', '.sass-cache',
	// Python
	'__pycache__', '__pypackages__', '.venv', '.tox', '.nox', '.eggs', '.pytest_cache',
	'.mypy_cache', '.ruff_cache', '.pytype', '.pyre', '.hypothesis', 'htmlcov',
	'.ipynb_checkpoints', '.pdm-build',
	// JVM / Android / native
	'.gradle', '.kotlin', '.cxx', '.externalNativeBuild',
	// Apple
	'DerivedData', '.build', '.swiftpm', 'xcuserdata',
	// Dart / Flutter
	'.dart_tool', '.pub-cache',
	// Haskell, OCaml, Elm, Zig, Nim
	'.stack-work', 'dist-newstyle', '_opam', '_esy', 'elm-stuff',
	'.zig-cache', 'zig-cache', 'zig-out', 'nimcache',
	// Game engines, R
	'.godot', '.Rproj.user',
	// Monorepo build systems
	'buck-out', '.pants.d',
	// Infrastructure
	'.terraform', '.terragrunt-cache', '.aws-sam',
	// Editors and IDEs (state churn, not settings people hand-edit)
	'.idea', '.vs',
	// PHP / Go / Ruby dependency copies
	'vendor',
	// Generic caches and scratch space
	'.cache', '.temp', '.tmp'
]);

/** Layer 1, by prefix: names that carry a variable suffix. */
const IGNORED_DIR_PREFIXES = [
	'cmake-build-' // CLion: cmake-build-debug, cmake-build-release, …
];

/** Files that change constantly and never matter to the explorer. */
const IGNORED_FILES = new Set([
	'.DS_Store',
	'Thumbs.db',
	'.gitkeep',
	'.gitignore~',
	'.eslintcache',
	'.stylelintcache'
]);

/** Vim swap files (`.name.swp`, `.swo`, …) — rewritten on every keystroke. */
const EDITOR_SWAP_FILE = /^\..+\.sw[a-p]$/;

/**
 * Layer 2: a name that is output only in the ecosystem whose manifest sits
 * beside it. `marker` is tested against every sibling entry name.
 */
interface MarkedOutputDir {
	dir: RegExp;
	marker: RegExp;
}

const MARKED_OUTPUT_DIRS: MarkedOutputDir[] = [
	// Rust, Maven, sbt, Leiningen
	{ dir: /^target$/, marker: /^(Cargo\.toml|pom\.xml|build\.sbt|project\.clj)$/ },
	// .NET (Unity generates .csproj files at its root too)
	{ dir: /^(bin|obj)$/, marker: /\.(cs|fs|vb)proj$/ },
	// Elixir, Erlang (rebar3), OCaml (dune)
	{ dir: /^_build$/, marker: /^(mix\.exs|rebar\.config|dune-project)$/ },
	{ dir: /^deps$/, marker: /^mix\.exs$/ },
	// Next.js static export
	{ dir: /^out$/, marker: /^next\.config\.(js|cjs|mjs|ts)$/ },
	// CocoaPods
	{ dir: /^Pods$/, marker: /^Podfile$/ },
	// Unity
	{ dir: /^(Library|Temp|Logs|UserSettings)$/, marker: /^ProjectSettings$/ },
	// Unreal Engine
	{ dir: /^(Binaries|Intermediate|Saved|DerivedDataCache)$/, marker: /\.uproject$/ },
	// Bazel output symlinks: bazel-bin, bazel-out, bazel-<workspace>, …
	{ dir: /^bazel-/, marker: /^(WORKSPACE|WORKSPACE\.bazel|MODULE\.bazel)$/ }
];

/**
 * Layer 3: an entry that marks the directory CONTAINING it as generated.
 *
 * - `CACHEDIR.TAG` is the cross-tool cache-directory standard
 *   (bford.info/cachedir); Cargo's `target/` and the pytest, mypy and ruff
 *   caches all write one.
 * - `pyvenv.cfg` sits at the root of every Python virtualenv, whatever the
 *   folder is called (`env`, `venv`, `.env3`, `myenv`, …).
 * - `conda-meta` does the same for conda environments.
 */
const SIGNATURE_ENTRIES = new Set(['CACHEDIR.TAG', 'pyvenv.cfg', 'conda-meta']);

/** Whether one path segment is ignored by name alone (layer 1). */
export function isIgnoredName(name: string): boolean {
	if (IGNORED_DIRS.has(name) || IGNORED_FILES.has(name)) return true;
	if (EDITOR_SWAP_FILE.test(name)) return true;
	return IGNORED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Whether a project-relative path crosses a segment ignored by name. */
export function isIgnoredPath(relativePath: string): boolean {
	return relativePath.split('/').some(isIgnoredName);
}

/** Layer 2: whether `name` is generated output given its sibling entries. */
export function isMarkedOutputDir(name: string, siblingNames: readonly string[]): boolean {
	return MARKED_OUTPUT_DIRS.some(
		(rule) => rule.dir.test(name) && siblingNames.some((sibling) => rule.marker.test(sibling))
	);
}

/** Layer 3: whether a directory's own entries declare it generated. */
export function hasGeneratedSignature(entryNames: readonly string[]): boolean {
	return entryNames.some((name) => SIGNATURE_ENTRIES.has(name));
}

/** A signature entry: its arrival or removal re-decides its parent directory. */
export function isSignatureEntry(name: string): boolean {
	return SIGNATURE_ENTRIES.has(name);
}

/** A manifest: its arrival or removal re-decides its sibling directories. */
export function isOutputMarker(name: string): boolean {
	return MARKED_OUTPUT_DIRS.some((rule) => rule.marker.test(name));
}

/** Whether a directory name could be output under some manifest (layer 2). */
export function isMarkableDirName(name: string): boolean {
	return MARKED_OUTPUT_DIRS.some((rule) => rule.dir.test(name));
}

async function listNames(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

/**
 * Layers 2 and 3 need the disk, so their answers are cached per directory.
 * The cache is kept honest by events rather than a clock: the watcher calls
 * {@link forget} when a signature or manifest appears or disappears, and
 * {@link forgetTree} when a directory is removed.
 */
export class GeneratedDirClassifier {
	private readonly decisions = new Map<string, Promise<boolean>>();

	constructor(private readonly root: string) {}

	/**
	 * Whether `absDir` is generated by layer 2 or 3. `siblingNames` and
	 * `ownNames` skip the directory reads when the caller already listed them.
	 */
	isGenerated(absDir: string, siblingNames?: readonly string[], ownNames?: readonly string[]): Promise<boolean> {
		const cached = this.decisions.get(absDir);
		if (cached) return cached;
		const decision = (async () => {
			if (absDir === this.root) return false;
			const name = basename(absDir);
			if (isMarkableDirName(name)) {
				const siblings = siblingNames ?? (await listNames(dirname(absDir)));
				if (isMarkedOutputDir(name, siblings)) return true;
			}
			return hasGeneratedSignature(ownNames ?? (await listNames(absDir)));
		})();
		this.decisions.set(absDir, decision);
		return decision;
	}

	/**
	 * Whether a project-relative path lies under a generated directory. Only
	 * ancestors are judged: the path itself is reported even when it is such a
	 * directory, so a freshly created `target/` still appears in the explorer.
	 */
	async isInsideGenerated(relativePath: string): Promise<boolean> {
		const segments = relativePath.split('/');
		let dir = this.root;
		for (let i = 0; i < segments.length - 1; i++) {
			dir = join(dir, segments[i]);
			if (await this.isGenerated(dir)) return true;
		}
		return false;
	}

	/** Drop the decision for one directory so the next query re-reads the disk. */
	forget(absDir: string): void {
		this.decisions.delete(absDir);
	}

	/**
	 * Drop the decisions a manifest in `parentDir` could change: its children
	 * whose names some ecosystem treats as output.
	 */
	forgetMarkableChildren(parentDir: string): void {
		for (const dir of this.decisions.keys()) {
			if (dirname(dir) === parentDir && isMarkableDirName(basename(dir))) this.decisions.delete(dir);
		}
	}

	/** Drop decisions for a directory and everything under it (it was removed). */
	forgetTree(absDir: string): void {
		const prefix = absDir.endsWith(sep) ? absDir : absDir + sep;
		for (const dir of this.decisions.keys()) {
			if (dir === absDir || dir.startsWith(prefix)) this.decisions.delete(dir);
		}
	}
}
