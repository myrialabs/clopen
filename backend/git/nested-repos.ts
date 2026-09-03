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
 * Names alone cannot separate the two. `plugins/` holds tmux's cloned packages
 * and a WordPress developer's own plugin repos; `modules/` holds Puppet's
 * librarian checkouts and hand-written modules. Any denylist of directory
 * names is wrong on one side of those, and every new package manager adds
 * another name to chase. So the policy leans on structure instead:
 *
 * 1. **Name, for cost only** — `HARD_SKIP_DIRS` are caches so large that
 *    walking them is wasteful. Pruning them is an optimisation, not the policy.
 * 2. **Ignore state** — a directory the enclosing repo ignores is not part of
 *    the project's own structure. We still peek `IGNORED_DESCENT_LEVELS` level
 *    into it, because an embedded repo is commonly placed directly under an
 *    ignored parent (`wp-content/plugins/` ignored, the plugin repo inside it).
 * 3. **Local work** — a repo found inside an ignored tree is reported only if
 *    it has something to show: uncommitted changes, or a `.gitmodules` entry
 *    declaring it. A package manager's checkout is pristine by construction —
 *    it is a clone at a pinned ref that nobody edits — so this drops Mix's
 *    `deps/*`, OpenWrt's `feeds/*`, Vim's `bundle/*` and every future
 *    equivalent without naming any of them. A repo the user actually works in
 *    appears the moment there is a change to see, which is exactly when the
 *    Changes tab needs it.
 *
 * Repos in the project's own tracked structure are never subject to (3): they
 * are listed whether or not they are clean. That includes a repo whose own
 * path is ignored while its parents are tracked — a directory that is itself a
 * repo is recognised before its ignore state is ever consulted.
 *
 * A repo found this way resets the ignore budget: its own contents are then
 * judged by its own `.gitignore`, not the outer repo's.
 */

import fs from 'fs/promises';
import path from 'path';
import { debug } from '$shared/utils/logger';
import { execGit } from './git-executor';

/**
 * Directories large enough that walking them is pure waste — VCS internals and
 * the big dependency caches. Pruned by name at any depth, whether or not the
 * enclosing repo ignores them. This list is a cost guard, not the policy: what
 * keeps package checkouts out of the panel is rule (3) above, so a name
 * missing from here costs a little walking, not a wrong answer.
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
 * Discovery caching, and who is allowed to decide it is stale.
 *
 * Every `git:status` / `git:branches` used to re-answer "which directories
 * under this root are repos" from scratch: an `fs.readdir` over the whole tree
 * plus a `git check-ignore` spawn per repo per depth level, then one
 * `git status` per repo sitting inside an ignored tree. Measured on a real
 * project that is 132ms and 7 spawns for the walk alone, and the panel fires it
 * three or four times a second while staging. On Windows every spawn and every
 * readdir also pays for Defender, which is what made Stage All look frozen.
 *
 * The answer barely ever changes, and the file watcher already knows exactly
 * when it does. So the watcher, not a clock, is the invalidation authority:
 *
 *   - `beginWatchedDiscovery` / `endWatchedDiscovery` — a root is "watched"
 *     while a live watcher is feeding it signals.
 *   - `invalidateRepoSet` — a `.git` appeared or vanished, or `.gitignore` /
 *     `.gitmodules` changed. The set of repos may be different.
 *   - `invalidateLocalWork` — something was written inside one repo, so only
 *     that repo's "does it have work to show" verdict is suspect.
 *
 * THE SAFETY RULE, which every change here must preserve: **the watcher only
 * ever makes an answer fresher, never staler.** A TTL is always the floor, so
 * losing every signal degrades to re-walking on a timer — never to an answer
 * that is wrong forever. That failure mode is not hypothetical: `resolveGitDirs`
 * decides which git dirs get watched at all and rejects unaccounted-for ones
 * permanently, so one stale walk there took a sub-repo out of the panel for the
 * whole session.
 *
 * The two halves have different exposure, so they are cached separately:
 *
 *   - The WALK (which dirs hold a `.git`) is stable, and the signal for it —
 *     a `.git` entry appearing — is one the watcher sees reliably on every
 *     platform, because the repo's parent directory is watched. Long floor.
 *   - LOCAL WORK (whether a repo inside an ignored tree has anything to show)
 *     changes with ordinary file writes, and the watcher is blind inside the
 *     directories it prunes by name. Cached ONLY for watched roots, where a
 *     write lands as an invalidation; an unwatched caller (the snapshot
 *     scanner, a CLI path) still probes live, exactly as before. Hiding a
 *     sub-repo the user edits is the worst failure this module can produce, so
 *     it does not get cached on a guess.
 *
 * What is never cached, at any point: file status. Staged, unstaged, untracked
 * and conflicted entries come from a live `git status` per repo on every call.
 * The Changes tab cannot go stale through this module.
 */

/** Floor for a root nobody is invalidating — the clock is the only signal. */
const UNWATCHED_TTL_MS = process.platform === 'win32' ? 5000 : 3000;

/**
 * Floor for a watched root. Long, because the watcher normally invalidates
 * within milliseconds; this only bounds the damage if a signal is ever missed
 * (a platform that drops an event, a watcher that faulted and is restarting).
 */
const WATCHED_TTL_MS = 60_000;

interface WalkEntryCache {
	found: string[];
	provisional: string[];
	expiresAt: number;
}

/** Whether a sub-repo has anything the panel could show. Watched roots only. */
interface LocalWorkCache {
	hasWork: boolean;
	expiresAt: number;
}

const nestedRepoWalkCache = new Map<string, WalkEntryCache>();
const nestedRepoInflight = new Map<string, Promise<string[]>>();
const localWorkCache = new Map<string, LocalWorkCache>();

/**
 * Project roots a live file watcher is feeding signals for, and how many
 * watchers are doing so. Refcounted because two projects can be opened at the
 * same directory: without it the first one to close would revoke the claim
 * while the second is still reporting, and discovery would quietly go back to
 * the clock while a perfectly good signal source was still running.
 */
const watchedRoots = new Map<string, number>();

/**
 * The key every cache and the watched-root set is stored under. Callers reach
 * this module from both sides of a `path.normalize()` — the watcher normalises
 * the project path before registering, `git:status` passes `project.path`
 * straight through — and on Windows those differ by separator alone. Keying on
 * the raw string would put them in two entries: the watcher would invalidate
 * one while the panel read the other, silently turning the signal off.
 * Values keep their native separators; only keys are folded.
 */
function cacheKey(inputPath: string): string {
	return inputPath.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** Whether `candidate` is `base` or sits underneath it. */
function isUnder(base: string, candidate: string): boolean {
	const baseKey = cacheKey(base);
	const candidateKey = cacheKey(candidate);
	return candidateKey === baseKey || candidateKey.startsWith(baseKey + '/');
}

function isWatched(rootPath: string): boolean {
	return (watchedRoots.get(cacheKey(rootPath)) ?? 0) > 0;
}

function ttlFor(rootPath: string): number {
	return isWatched(rootPath) ? WATCHED_TTL_MS : UNWATCHED_TTL_MS;
}

/**
 * Declare that a live file watcher will report changes for `rootPath`. Until
 * `endWatchedDiscovery`, discovery may lean on those signals instead of the
 * short clock — and `hasLocalWork` verdicts become cacheable at all.
 */
export function beginWatchedDiscovery(rootPath: string): void {
	const key = cacheKey(rootPath);
	watchedRoots.set(key, (watchedRoots.get(key) ?? 0) + 1);
}

/**
 * The watcher for `rootPath` is gone. Drop everything that was only safe
 * because it was being invalidated, so the next call re-probes live.
 */
export function endWatchedDiscovery(rootPath: string): void {
	const key = cacheKey(rootPath);
	const remaining = (watchedRoots.get(key) ?? 0) - 1;
	if (remaining > 0) {
		watchedRoots.set(key, remaining);
		return;
	}
	watchedRoots.delete(key);
	nestedRepoWalkCache.delete(key);
	for (const cachedRepoKey of Array.from(localWorkCache.keys())) {
		if (isUnder(rootPath, cachedRepoKey)) localWorkCache.delete(cachedRepoKey);
	}
}

/**
 * The set of repos under `rootPath` may have changed — a `.git` appeared or
 * vanished, or the rules that decide what counts (`.gitignore`, `.gitmodules`)
 * were edited. Forces a fresh walk on the next call.
 */
export function invalidateRepoSet(rootPath: string): void {
	nestedRepoWalkCache.delete(cacheKey(rootPath));
}

/**
 * Whether a changed path is one that can change WHICH repos are reported, as
 * opposed to what is inside one.
 *
 * These live here rather than in the watcher on purpose. They are facts about
 * the sub-repo policy at the top of this file, not about filesystem events, so
 * extending that policy has to mean editing one place. Splitting them across
 * the two files is what let discovery and its invalidation drift apart in the
 * first place.
 */
function isRepoSetRule(changedPath: string): boolean {
	const segments = cacheKey(changedPath).split('/');
	const basename = segments[segments.length - 1];

	// The repository itself appearing or vanishing.
	if (basename === '.git') return true;

	// Rule (2) and rule (3): what the project ignores, and what it declares.
	if (basename === '.gitignore' || basename === '.gitmodules') return true;

	// `.git/info/exclude` is a per-repo ignore file `git check-ignore` obeys
	// exactly like `.gitignore`, so it moves the same boundary. The watcher
	// filters it out of the panel's git-state events — correctly, the panel has
	// nothing to show for it — which is precisely why discovery has to ask for
	// it by name instead of riding along with those.
	return (
		basename === 'exclude' &&
		segments[segments.length - 2] === 'info' &&
		segments[segments.length - 3] === '.git'
	);
}

/**
 * A path under `rootPath` changed. The single entry point the file watcher
 * uses: it forwards raw paths and this module decides what each one means, so
 * no caller has to carry a copy of the sub-repo policy.
 *
 * Ignored entirely for a root nobody claimed — an unwatched root caches
 * nothing that a signal could correct, and answering it here would only hide
 * that fact.
 */
export function notifyPathChanged(rootPath: string, changedPath: string): void {
	if (!isWatched(rootPath)) return;
	if (isRepoSetRule(changedPath)) invalidateRepoSet(rootPath);
	dropLocalWorkUnder(changedPath);
}

/**
 * Something at or under `changedPath` moved, so the "has work to show" verdict
 * of every cached repo containing it is suspect.
 *
 * Matching by containment rather than taking a repo path directly is what makes
 * the important case work. A pristine sub-repo inside an ignored tree is NOT in
 * the watcher's repo list — it is deliberately unreported until it has
 * something to show, so the watcher has never resolved a git dir for it. The
 * transition that must be caught is exactly the first write into it, and at
 * that moment the only place it is known by name is this cache, holding the
 * `false` verdict that is about to become wrong.
 *
 * Still scoped: a write in one sub-repo says nothing about its siblings, and
 * re-probing all of them is the cost this cache exists to avoid.
 */
function dropLocalWorkUnder(changedPath: string): void {
	for (const cachedRepoKey of Array.from(localWorkCache.keys())) {
		if (isUnder(cachedRepoKey, changedPath)) localWorkCache.delete(cachedRepoKey);
	}
}

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
	/**
	 * True once the walk has crossed into a tree the project ignores. Repos
	 * found from here on must prove they hold local work before being
	 * reported, and the flag is inherited so a repo nested inside a rejected
	 * package checkout does not slip through on its own clean ignore state.
	 */
	insideIgnored: boolean;
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

/**
 * Whether `repoPath` has anything the Git panel could show — staged, unstaged,
 * untracked or conflicted entries. This is what separates a repo the user
 * works in from a package manager's checkout, which is a clone at a pinned ref
 * that nobody edits and so reports nothing.
 *
 * A repo we cannot read is reported as having work: hiding a sub-repo the user
 * edits is a far worse failure than showing one they do not care about.
 */
async function probeLocalWork(repoPath: string): Promise<boolean> {
	try {
		const result = await execGit(['status', '--porcelain', '-z'], repoPath, { timeout: 15000 });
		if (result.exitCode !== 0) return true;
		return result.stdout.length > 0;
	} catch {
		return true;
	}
}

/**
 * `probeLocalWork` with the verdict remembered — but only under a root the
 * watcher is invalidating, where a write inside the repo lands as an
 * `invalidateLocalWork` before anyone can read a stale answer. Unwatched roots
 * probe live every time: this is the verdict that decides whether a sub-repo is
 * shown at all, and a cached "nothing to show" with no signal behind it would
 * hide a repo the user is working in.
 */
async function hasLocalWork(rootPath: string, repoPath: string): Promise<boolean> {
	if (!isWatched(rootPath)) return probeLocalWork(repoPath);

	const cached = localWorkCache.get(cacheKey(repoPath));
	if (cached && Date.now() < cached.expiresAt) return cached.hasWork;

	const hasWork = await probeLocalWork(repoPath);
	// Re-read the flag: the watcher may have stopped while the probe ran, and a
	// verdict nobody will invalidate must not be left behind.
	if (isWatched(rootPath)) {
		localWorkCache.set(cacheKey(repoPath), { hasWork, expiresAt: Date.now() + WATCHED_TTL_MS });
	}
	return hasWork;
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
 *
 * The filesystem walk is cached for a few seconds (longer on Windows) and
 * concurrent callers for the same root share a single walk via inflight
 * deduplication. The provisional → found filtering is re-run on every call
 * so a newly-dirtied repo appears immediately.
 */
export async function findNestedRepoPaths(rootPath: string): Promise<string[]> {
	const cachedWalk = nestedRepoWalkCache.get(cacheKey(rootPath));
	if (cachedWalk && Date.now() < cachedWalk.expiresAt) {
		return resolveProvisional(rootPath, cachedWalk.found, cachedWalk.provisional);
	}

	// A caller that arrives while a walk is running shares it instead of
	// starting a second one, but gets its own copy of the result: the array
	// goes out to unrelated call sites, and one of them mutating it in place
	// would corrupt the others.
	const inflight = nestedRepoInflight.get(cacheKey(rootPath));
	if (inflight) return [...(await inflight)];

	const promise = (async (): Promise<string[]> => {
		const walk = await walkNestedRepos(rootPath);
		nestedRepoWalkCache.set(cacheKey(rootPath), {
			found: walk.found,
			provisional: walk.provisional,
			expiresAt: Date.now() + ttlFor(rootPath)
		});
		return resolveProvisional(rootPath, walk.found, walk.provisional);
	})();

	nestedRepoInflight.set(cacheKey(rootPath), promise);
	try {
		return await promise;
	} finally {
		nestedRepoInflight.delete(cacheKey(rootPath));
	}
}

/**
 * Decide which provisional repos (those found inside an ignored tree) earn a
 * place in the result, and return the sorted list. Deliberately outside the
 * WALK cache: a repo qualifies the moment it gains local work, so a cached walk
 * must never carry a cached verdict with it. The verdicts have their own,
 * signal-backed cache — see `hasLocalWork`.
 */
async function resolveProvisional(rootPath: string, found: string[], provisional: string[]): Promise<string[]> {
	if (provisional.length === 0) {
		const out = [...found];
		out.sort();
		return out;
	}
	const submodulePaths = await findSubmodulePaths(rootPath);
	const isDeclared = (repoPath: string) =>
		submodulePaths.has(path.relative(rootPath, repoPath).replace(/\\/g, '/'));
	const verdicts = await Promise.all(
		provisional.map(async (repoPath) => isDeclared(repoPath) || (await hasLocalWork(rootPath, repoPath)))
	);
	const out = [...found];
	provisional.forEach((repoPath, i) => {
		if (verdicts[i]) out.push(repoPath);
	});
	out.sort();
	return out;
}

/**
 * The raw, uncached filesystem walk. Returns repos split into those reportable
 * on structure alone and those still needing to prove local work — the split
 * `findNestedRepoPaths` caches, because only the first half is stable.
 */
async function walkNestedRepos(rootPath: string): Promise<{ found: string[]; provisional: string[] }> {
	const found: string[] = [];
	/** Repos found inside an ignored tree — reported only if they prove local work. */
	const provisional: string[] = [];
	let level: WalkEntry[] = [
		{ dirPath: rootPath, repoRoot: rootPath, ignoredBudget: null, insideIgnored: false }
	];
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
				if (c.parent.insideIgnored) {
					// Candidates from an ignored tree get their own budget, so a
					// directory full of package checkouts bounds the `git status`
					// work without blinding the rest of the walk to real sub-repos.
					if (provisional.length >= MAX_REPOS) return;
					provisional.push(c.fullPath);
				} else {
					if (found.length >= MAX_REPOS) {
						truncated = true;
						return;
					}
					found.push(c.fullPath);
				}
				// Inside a repo, its own ignore rules apply from scratch — but a
				// repo buried in an ignored tree cannot launder its children.
				next.push({
					dirPath: c.fullPath,
					repoRoot: c.fullPath,
					ignoredBudget: null,
					insideIgnored: c.parent.insideIgnored
				});
				return;
			}

			let budget = c.parent.ignoredBudget;
			if (budget === null) {
				const ignored = ignoredByRepo.get(c.parent.repoRoot);
				if (!ignored?.has(c.relPath)) {
					// Part of the project's own structure — descend freely.
					next.push({
						dirPath: c.fullPath,
						repoRoot: c.parent.repoRoot,
						ignoredBudget: null,
						insideIgnored: c.parent.insideIgnored
					});
					return;
				}
				budget = IGNORED_DESCENT_LEVELS;
			} else {
				budget -= 1;
			}
			// Inside an ignored tree: keep looking only while the budget lasts.
			if (budget > 0) {
				next.push({
					dirPath: c.fullPath,
					repoRoot: c.parent.repoRoot,
					ignoredBudget: budget,
					insideIgnored: true
				});
			}
		});

		level = next;
	}

	if (truncated) {
		debug.warn('git', `Nested repo scan of ${rootPath} stopped at ${MAX_REPOS} repos`);
	}

	return { found, provisional };
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
 * Drop every cached answer so the next call re-scans and re-probes. Exists for
 * tests, which mutate a project's layout far faster than any TTL and would
 * otherwise assert against the previous fixture. Production code should reach
 * for the targeted `invalidateRepoSet` / `invalidateLocalWork` instead, so one
 * repo's churn does not throw away every other repo's answer.
 */
export function clearNestedRepoCache(rootPath?: string): void {
	if (rootPath) {
		nestedRepoWalkCache.delete(cacheKey(rootPath));
		nestedRepoInflight.delete(cacheKey(rootPath));
		for (const cachedRepoKey of Array.from(localWorkCache.keys())) {
			if (isUnder(rootPath, cachedRepoKey)) localWorkCache.delete(cachedRepoKey);
		}
	} else {
		nestedRepoWalkCache.clear();
		nestedRepoInflight.clear();
		localWorkCache.clear();
		watchedRoots.clear();
	}
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
