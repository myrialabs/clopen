/**
 * Gitignore-aware file filtering
 *
 * Two strategies:
 * 1. Git repo: Use `git ls-files -co --exclude-standard` (perfect accuracy)
 * 2. Non-git repo: Parse .gitignore files manually (fallback)
 *
 * Handles nested .gitignore files in subdirectories with proper scoping.
 */

import fs from 'fs/promises';
import path from 'path';
import { debug } from '$shared/utils/logger';
import { execGit } from '../git/git-executor';

/**
 * Safety-net directories to always exclude regardless of .gitignore.
 * These are never useful in snapshots and could be massive.
 */
const ALWAYS_EXCLUDE_DIRS = new Set([
	'.git',
	'node_modules',
]);

/**
 * Find paths of all nested git repos (directories with their own `.git`) at any
 * depth under `rootPath`. Walks into nested repos to find deeply nested ones.
 * Does NOT scan the repos — just returns their absolute paths.
 *
 * Used by callers that need to run git commands inside each nested repo
 * (e.g. `git:status` aggregating changes from nested repos into the Changes
 * tab of the Git panel).
 */
export async function findNestedRepoPaths(rootPath: string): Promise<string[]> {
	const paths: string[] = [];

	const walk = async (currentPath: string): Promise<void> => {
		let entries;
		try {
			entries = await fs.readdir(currentPath, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (ALWAYS_EXCLUDE_DIRS.has(entry.name)) continue;

			const fullPath = path.join(currentPath, entry.name);

			// Check if this directory is itself a git repo
			try {
				await fs.access(path.join(fullPath, '.git'));
				paths.push(fullPath);
				// Fall through to also walk into it for deeper nested repos
			} catch {
				// Not a git repo
			}

			await walk(fullPath);
		}
	};

	await walk(rootPath);
	return paths;
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

/**
 * Get list of snapshot-eligible files using git (preferred) or manual scan.
 * Returns full absolute paths.
 */
export async function getSnapshotFiles(projectPath: string): Promise<string[]> {
	// Try git-based scan first (handles all .gitignore rules perfectly)
	const gitFiles = await scanWithGit(projectPath);
	if (gitFiles !== null) {
		return gitFiles;
	}

	// Fallback: manual scan with .gitignore parsing
	return scanWithGitignoreParsing(projectPath);
}

// ============================================================================
// Strategy 1: Git-based scanning
// ============================================================================

async function scanWithGit(dirPath: string): Promise<string[] | null> {
	// Check if this is a git repo
	try {
		await fs.access(path.join(dirPath, '.git'));
	} catch {
		return null;
	}

	try {
		// Scan the outer repo
		const files = await scanSingleGitRepo(dirPath);

		// Find and scan nested git repos — separate repositories living inside
		// the project (e.g. a theme extracted into its own repo). The parent
		// repo's `git ls-files --exclude-standard` skips these because git treats
		// a nested repo as a single gitlink entry (or excludes it entirely when
		// it's listed in the parent's .gitignore). Without this step, files
		// inside nested repos are invisible to the snapshot system, so AI
		// changes to them never appear in the checkpoint banner.
		const nestedFiles = await findAndScanNestedRepos(dirPath);

		const allFiles = [...files, ...nestedFiles];
		debug.log('snapshot', `Git scan found ${allFiles.length} files (${files.length} outer, ${nestedFiles.length} nested)`);
		return allFiles;
	} catch (err) {
		debug.warn('snapshot', 'git ls-files failed, falling back to manual scan:', err);
		return null;
	}
}

/**
 * Run `git ls-files -co --exclude-standard` in a single git repo and return
 * absolute paths. Used for both the outer repo and nested repos.
 */
async function scanSingleGitRepo(dirPath: string): Promise<string[]> {
	try {
		const result = await execGit(['ls-files', '-co', '--exclude-standard'], dirPath, 60_000);
		if (result.exitCode !== 0) return [];

		const files: string[] = [];
		for (const line of result.stdout.split('\n')) {
			const relativePath = line.trim();
			if (!relativePath) continue;

			// Skip always-excluded directories
			const firstSegment = relativePath.split('/')[0];
			if (ALWAYS_EXCLUDE_DIRS.has(firstSegment)) continue;

			// Skip directory entries — git emits nested repos as a single
			// entry with a trailing slash (e.g. `theme/`). These are handled
			// by findAndScanNestedRepos, not here.
			if (relativePath.endsWith('/')) continue;

			files.push(path.join(dirPath, relativePath));
		}
		return files;
	} catch (err) {
		debug.warn('snapshot', `git ls-files failed for ${dirPath}:`, err);
		return [];
	}
}

/**
 * Walk the project tree to find nested git repos (directories with their own
 * `.git`) and scan each one independently. This catches nested repos that are
 * gitignored by the parent — they'd otherwise be invisible to the outer repo's
 * `git ls-files --exclude-standard`.
 *
 * The walk respects ALWAYS_EXCLUDE_DIRS (skips `.git`, `node_modules`) but does
 * NOT respect .gitignore, because the nested repo we're looking for may itself
 * be gitignored by the parent. Once a nested repo is found, its own
 * `git ls-files --exclude-standard` handles its .gitignore rules.
 */
async function findAndScanNestedRepos(rootPath: string): Promise<string[]> {
	const files: string[] = [];

	const walk = async (currentPath: string): Promise<void> => {
		let entries;
		try {
			entries = await fs.readdir(currentPath, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (ALWAYS_EXCLUDE_DIRS.has(entry.name)) continue;

			const fullPath = path.join(currentPath, entry.name);

			// Check if this directory is itself a git repo (`.git` can be a
			// directory or a file — the latter for worktrees/submodules).
			try {
				await fs.access(path.join(fullPath, '.git'));
				// Nested repo found — scan it independently, then continue
				// walking into it to find even deeper nested repos.
				const nestedFiles = await scanSingleGitRepo(fullPath);
				files.push(...nestedFiles);
				await walk(fullPath);
				continue;
			} catch {
				// Not a git repo — recurse to find deeper nested repos
			}

			await walk(fullPath);
		}
	};

	await walk(rootPath);
	return files;
}

// ============================================================================
// Strategy 2: Manual scan with .gitignore parsing
// ============================================================================

/**
 * Rule from a .gitignore file.
 * scope = relative directory containing the .gitignore ('' for root).
 */
interface IgnoreRule {
	pattern: RegExp;
	negate: boolean;
	dirOnly: boolean; // pattern ends with /
	scope: string; // relative dir of the .gitignore that defined this rule
}

/**
 * Parse a single .gitignore line into an IgnoreRule (or null if comment/blank).
 */
function parseGitignoreLine(line: string, scope: string): IgnoreRule | null {
	// Strip trailing whitespace (unless escaped)
	let trimmed = line.replace(/(?<!\\)\s+$/, '');

	// Skip empty lines and comments
	if (!trimmed || trimmed.startsWith('#')) return null;

	// Check for negation
	let negate = false;
	if (trimmed.startsWith('!')) {
		negate = true;
		trimmed = trimmed.slice(1);
	}

	// Check for directory-only marker
	let dirOnly = false;
	if (trimmed.endsWith('/')) {
		dirOnly = true;
		trimmed = trimmed.slice(0, -1);
	}

	// Determine if pattern is anchored (contains / other than at end)
	const anchored = trimmed.includes('/');

	// Build regex from glob pattern
	const regexStr = globToRegex(trimmed, anchored, scope);
	try {
		const pattern = new RegExp(regexStr);
		return { pattern, negate, dirOnly, scope };
	} catch {
		return null;
	}
}

/**
 * Convert a gitignore glob pattern to a regex string.
 *
 * Rules:
 * - `*` matches anything except /
 * - `**` matches everything (including /)
 * - `?` matches any single char except /
 * - If pattern contains / (anchored), match from scope root
 * - If pattern has no / (unanchored), match basename anywhere
 */
function globToRegex(pattern: string, anchored: boolean, scope: string): string {
	let result = '';

	// Process pattern character by character
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];

		if (ch === '*') {
			if (pattern[i + 1] === '*') {
				// ** pattern
				if (pattern[i + 2] === '/') {
					// **/ = match zero or more directories
					result += '(?:.*/)?';
					i += 3;
				} else if (i + 2 === pattern.length) {
					// ** at end = match everything
					result += '.*';
					i += 2;
				} else {
					// ** followed by something else
					result += '.*';
					i += 2;
				}
			} else {
				// single * = match anything except /
				result += '[^/]*';
				i++;
			}
		} else if (ch === '?') {
			result += '[^/]';
			i++;
		} else if (ch === '[') {
			// Character class - pass through
			const end = pattern.indexOf(']', i + 1);
			if (end !== -1) {
				result += pattern.slice(i, end + 1);
				i = end + 1;
			} else {
				result += '\\[';
				i++;
			}
		} else if ('.+^${}()|\\'.includes(ch)) {
			// Escape regex special chars
			result += '\\' + ch;
			i++;
		} else if (ch === '/') {
			result += '/';
			i++;
		} else {
			result += ch;
			i++;
		}
	}

	// Build final regex based on anchoring
	if (anchored) {
		// Pattern is relative to the .gitignore scope
		const prefix = scope ? scope + '/' : '';
		return '^' + escapeRegex(prefix) + result + '(?:/.*)?$';
	} else {
		// Unanchored: match basename anywhere, or as a path segment
		return '(?:^|/)' + result + '(?:/.*)?$';
	}
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gitignore rule collector.
 * Accumulates rules from multiple .gitignore files during directory traversal.
 */
class GitignoreFilter {
	private rules: IgnoreRule[] = [];

	/**
	 * Load and parse a .gitignore file
	 */
	async loadFromFile(filepath: string, scope: string): Promise<void> {
		try {
			const content = await fs.readFile(filepath, 'utf-8');
			for (const line of content.split('\n')) {
				const rule = parseGitignoreLine(line, scope);
				if (rule) this.rules.push(rule);
			}
		} catch {
			// File doesn't exist or can't be read - no rules to add
		}
	}

	/**
	 * Check if a path should be ignored.
	 * @param relativePath - Path relative to project root (forward slashes)
	 * @param isDirectory - Whether the path is a directory
	 */
	isIgnored(relativePath: string, isDirectory: boolean): boolean {
		let ignored = false;

		for (const rule of this.rules) {
			// Skip dir-only rules for files
			if (rule.dirOnly && !isDirectory) continue;

			// Check scope: rule only applies within its .gitignore directory
			if (rule.scope && !relativePath.startsWith(rule.scope + '/') && relativePath !== rule.scope) {
				continue;
			}

			if (rule.pattern.test(relativePath)) {
				ignored = !rule.negate;
			}
		}

		return ignored;
	}
}

/**
 * Scan directory manually, parsing .gitignore files at each level.
 */
async function scanWithGitignoreParsing(projectPath: string): Promise<string[]> {
	const files: string[] = [];
	const filter = new GitignoreFilter();

	// Load root .gitignore
	await filter.loadFromFile(path.join(projectPath, '.gitignore'), '');

	const scan = async (currentPath: string): Promise<void> => {
		try {
			const entries = await fs.readdir(currentPath, { withFileTypes: true });
			const relativeDir = path.relative(projectPath, currentPath).replace(/\\/g, '/');

			// Load .gitignore in this directory (if not root - root already loaded)
			if (relativeDir) {
				await filter.loadFromFile(path.join(currentPath, '.gitignore'), relativeDir);
			}

			for (const entry of entries) {
				const fullPath = path.join(currentPath, entry.name);
				const relativePath = path.relative(projectPath, fullPath).replace(/\\/g, '/');

				// Always exclude certain directories
				if (ALWAYS_EXCLUDE_DIRS.has(entry.name)) continue;

				if (entry.isDirectory()) {
					// Check if this is a nested git repo — scan it independently
					// and bypass the .gitignore filter so files inside a
					// gitignored nested repo are still tracked.
					try {
						await fs.access(path.join(fullPath, '.git'));
						const nestedFiles = await scanSingleGitRepo(fullPath);
						files.push(...nestedFiles);
						continue;
					} catch {
						// Not a git repo — apply gitignore filter and recurse
					}

					if (!filter.isIgnored(relativePath, true)) {
						await scan(fullPath);
					}
				} else if (entry.isFile()) {
					if (!filter.isIgnored(relativePath, false)) {
						files.push(fullPath);
					}
				}
			}
		} catch (err) {
			debug.warn('snapshot', `Could not read directory ${currentPath}:`, err);
		}
	};

	await scan(projectPath);
	debug.log('snapshot', `Manual scan found ${files.length} files`);
	return files;
}
