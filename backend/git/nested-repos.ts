/**
 * Nested git repo discovery — the single source of truth for "which sub-repos
 * live inside this project".
 *
 * Used by the Git panel (status/branches/conflicts aggregation), by the file
 * handlers that must run git inside the owning repo, and by the snapshot
 * scanner. Every caller MUST go through `findNestedRepoPaths` so they all agree
 * on what counts as a sub-repo.
 *
 * ## What counts as a sub-repo
 *
 * A directory with its own `.git` that the user actually works in — a theme or
 * plugin extracted into its own repo, a submodule, a worktree.
 *
 * What does NOT count: the hundreds of repos a package manager clones into a
 * build or cache directory (Swift Package Manager's
 * `build/…/SourcePackages/checkouts/*`, Carthage, Go module caches, …). They
 * are machine-generated, the user never commits them, and listing them floods
 * the Changes tab with thousands of foreign files.
 *
 * Two signals separate the two, both applied while walking:
 *
 * 1. **Name** — directories in `HARD_SKIP_DIRS` are dependency/build caches by
 *    definition; never descend into them.
 * 2. **Ignore state** — a directory the enclosing repo ignores is not part of
 *    the project's own structure. We still peek `IGNORED_DESCENT_LEVELS` level
 *    into it, because an embedded repo is commonly placed directly under an
 *    ignored parent (`wp-content/themes/` ignored, the theme repo inside it),
 *    but generated checkouts always sit much deeper.
 *
 * A repo found this way resets the ignore budget: its own contents are then
 * judged by its own `.gitignore`, not the outer repo's.
 */

import fs from 'fs/promises';
import path from 'path';
import { debug } from '$shared/utils/logger';
import { execGit } from './git-executor';

/**
 * Directories that never hold a user's own repo — VCS internals, dependency
 * caches, and package-manager checkout dirs. Pruned by name at any depth,
 * whether or not the enclosing repo ignores them (a project may well commit
 * its `Pods/`, and it still isn't where sub-repos live).
 */
const HARD_SKIP_DIRS = new Set([
	'.git', '.svn', '.hg',
	'node_modules', 'bower_components', '.yarn', '.pnpm-store',
	'Pods', 'Carthage', 'DerivedData', 'SourcePackages', '.build',
	'.gradle', '.m2', '.cargo', '.pub-cache', '.dart_tool', '.expo',
	'.venv', 'venv', '__pycache__', '.tox', '.stack-work',
	'.next', '.nuxt', '.svelte-kit', '.turbo', '.angular', '.parcel-cache',
	'.terraform', '.serverless', '.vercel', '.netlify', '.cache'
]);

/** How many levels below an ignored directory we still look for a repo. */
const IGNORED_DESCENT_LEVELS = 1;

/** Depth limit below the project root — a runaway walk helps nobody. */
const MAX_DEPTH = 12;

/**
 * Upper bound on reported sub-repos. A project with more than this is either
 * pathological or hit a detection hole; either way the UI cannot usefully show
 * them, so we stop and log instead of flooding it.
 */
const MAX_REPOS = 50;

/** One directory queued for inspection during the breadth-first walk. */
interface WalkEntry {
	/** Absolute path of the directory whose children we will inspect. */
	dirPath: string;
	/** Absolute path of the nearest enclosing git repo (for ignore checks). */
	repoRoot: string;
	/**
	 * Remaining levels we may descend while inside an ignored tree, or `null`
	 * when this directory is part of the enclosing repo's own structure.
	 */
	ignoredBudget: number | null;
}

/**
 * Ask the enclosing repo which of `relPaths` it ignores. Returns the ignored
 * subset. Batched so a walk costs one git call per repo per depth level, not
 * one per directory.
 */
async function filterIgnored(repoRoot: string, relPaths: string[]): Promise<Set<string>> {
	const ignored = new Set<string>();
	if (relPaths.length === 0) return ignored;

	try {
		// Paths go in over stdin: no argv limit, no quoting rules. Exit 1 just
		// means "none of these are ignored" — not a failure.
		const result = await execGit(['check-ignore', '-z', '--stdin'], repoRoot, {
			stdin: relPaths.join('\0'),
			okExitCodes: [1]
		});
		if (result.exitCode === 0) {
			for (const p of result.stdout.split('\0')) {
				if (p) ignored.add(p.replace(/\\/g, '/'));
			}
		}
	} catch {
		// Not a repo, or git unavailable — treat as "nothing ignored" and let
		// the name-based prune carry the walk.
	}

	return ignored;
}

/** Whether `dirPath` is a git repo (`.git` is a dir for clones, a file for worktrees/submodules). */
async function isRepoDir(dirPath: string): Promise<boolean> {
	try {
		await fs.access(path.join(dirPath, '.git'));
		return true;
	} catch {
		return false;
	}
}

/**
 * Find every nested git repo under `rootPath`, skipping dependency caches and
 * ignored trees (see the module comment for the exact policy). Does NOT scan
 * the repos — just returns their absolute paths, sorted for stable UI order.
 */
export async function findNestedRepoPaths(rootPath: string): Promise<string[]> {
	const found: string[] = [];
	let level: WalkEntry[] = [{ dirPath: rootPath, repoRoot: rootPath, ignoredBudget: null }];
	let truncated = false;

	for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth++) {
		// Collect this level's candidate children, grouped by enclosing repo so
		// the ignore check can be batched per repo.
		const candidates: Array<{ parent: WalkEntry; fullPath: string; relPath: string }> = [];
		for (const entry of level) {
			let entries;
			try {
				entries = await fs.readdir(entry.dirPath, { withFileTypes: true });
			} catch {
				continue; // unreadable dir — skip, never fail the whole walk
			}
			for (const child of entries) {
				// `isDirectory()` is false for symlinks, which also keeps the
				// walk free of symlink cycles.
				if (!child.isDirectory()) continue;
				if (HARD_SKIP_DIRS.has(child.name)) continue;
				const fullPath = path.join(entry.dirPath, child.name);
				candidates.push({
					parent: entry,
					fullPath,
					relPath: path.relative(entry.repoRoot, fullPath).replace(/\\/g, '/')
				});
			}
		}
		if (candidates.length === 0) break;

		// Ignore state is only needed for candidates that are not repos
		// themselves and whose parent isn't already inside an ignored tree.
		const repoFlags = await Promise.all(candidates.map((c) => isRepoDir(c.fullPath)));
		const needIgnoreCheck = new Map<string, string[]>();
		candidates.forEach((c, i) => {
			if (repoFlags[i] || c.parent.ignoredBudget !== null) return;
			const list = needIgnoreCheck.get(c.parent.repoRoot) ?? [];
			list.push(c.relPath);
			needIgnoreCheck.set(c.parent.repoRoot, list);
		});
		const ignoredByRepo = new Map<string, Set<string>>();
		for (const [repoRoot, relPaths] of needIgnoreCheck) {
			ignoredByRepo.set(repoRoot, await filterIgnored(repoRoot, relPaths));
		}

		const next: WalkEntry[] = [];
		candidates.forEach((c, i) => {
			if (repoFlags[i]) {
				if (found.length >= MAX_REPOS) {
					truncated = true;
					return;
				}
				found.push(c.fullPath);
				// Inside a repo, its own ignore rules apply from scratch.
				next.push({ dirPath: c.fullPath, repoRoot: c.fullPath, ignoredBudget: null });
				return;
			}

			let budget = c.parent.ignoredBudget;
			if (budget === null) {
				const ignored = ignoredByRepo.get(c.parent.repoRoot);
				if (!ignored?.has(c.relPath)) {
					// Part of the project's own structure — descend freely.
					next.push({ dirPath: c.fullPath, repoRoot: c.parent.repoRoot, ignoredBudget: null });
					return;
				}
				budget = IGNORED_DESCENT_LEVELS;
			} else {
				budget -= 1;
			}
			// Inside an ignored tree: keep looking only while the budget lasts.
			if (budget > 0) {
				next.push({ dirPath: c.fullPath, repoRoot: c.parent.repoRoot, ignoredBudget: budget });
			}
		});

		level = next;
	}

	if (truncated) {
		debug.warn('git', `Nested repo scan of ${rootPath} stopped at ${MAX_REPOS} repos`);
	}

	found.sort();
	return found;
}

/**
 * Read the outer repo's `.gitmodules` file and return the set of relative
 * submodule paths. Returns an empty set when the file is missing or unreadable
 * (e.g. the project isn't a git repo at all, or has no submodules).
 *
 * The format is INI-like:
 *   [submodule "vendor/foo"]
 *           path = vendor/foo
 *           url = git@example.com:vendor/foo.git
 *
 * The `path =` value is what we return — the directory inside the project root
 * where the submodule is checked out. If a section omits `path =`, git falls
 * back to the section name; we mirror that.
 */
export async function findSubmodulePaths(rootPath: string): Promise<Set<string>> {
	const out = new Set<string>();
	let raw: string;
	try {
		raw = await fs.readFile(path.join(rootPath, '.gitmodules'), 'utf8');
	} catch {
		return out; // file missing → no submodules
	}

	// Two-pass parse: collect per-section { name, path? } then resolve.
	// Single-pass is simpler but needs careful handling of the implicit
	// section-name fallback; the two-pass version reads more clearly.
	const sections: Array<{ name: string; path?: string }> = [];
	let current: { name: string; path?: string } | null = null;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const sectionMatch = trimmed.match(/^\[submodule\s+"([^"]+)"\]\s*$/);
		if (sectionMatch) {
			if (current) sections.push(current);
			current = { name: sectionMatch[1] };
			continue;
		}
		if (!current) continue;

		const pathMatch = trimmed.match(/^path\s*=\s*(.+?)\s*$/);
		if (pathMatch) current.path = pathMatch[1].replace(/\\/g, '/');
	}
	if (current) sections.push(current);

	for (const s of sections) {
		out.add(s.path ?? s.name);
	}
	return out;
}

/**
 * Given a file path relative to the project root, find the deepest nested
 * git repo that contains it. Returns the repo's absolute path and the file
 * path relative to that repo, or `null` if the file lives in the outer repo.
 *
 * Used by git staging/discard handlers so that `git add` / `git restore` /
 * `git rm` run inside the correct repo (the outer repo's `git` would skip
 * or fail on files that are tracked by a nested repo).
 */
export async function findRepoForFile(
	projectPath: string,
	filePath: string
): Promise<{ repoPath: string; relativeFilePath: string } | null> {
	const normalizedFilePath = filePath.replace(/\\/g, '/');
	const nestedRepoPaths = await findNestedRepoPaths(projectPath);

	let bestMatch: { repoPath: string; relativeFilePath: string } | null = null;
	let bestRepoRelLen = -1;

	for (const repoPath of nestedRepoPaths) {
		const repoRel = path.relative(projectPath, repoPath).replace(/\\/g, '/');
		// File is inside this repo if its path starts with `repoRel/`
		if (normalizedFilePath === repoRel || normalizedFilePath.startsWith(repoRel + '/')) {
			if (repoRel.length > bestRepoRelLen) {
				bestMatch = {
					repoPath,
					relativeFilePath: normalizedFilePath === repoRel
						? ''
						: normalizedFilePath.substring(repoRel.length + 1)
				};
				bestRepoRelLen = repoRel.length;
			}
		}
	}

	return bestMatch;
}
