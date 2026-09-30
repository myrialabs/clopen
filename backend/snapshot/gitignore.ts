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
import type { Dirent } from 'fs';
import path from 'path';
import { debug } from '$shared/utils/logger';
import { execGit } from '../git/git-executor';
import { findNestedRepoPaths } from '../git/nested-repos';
import { hasGeneratedSignature, isIgnoredName, isMarkedOutputDir } from '../files/watch-ignore';

/**
 * Safety-net directories to always exclude regardless of .gitignore.
 * These are never useful in snapshots and could be massive.
 */
const ALWAYS_EXCLUDE_DIRS = new Set([
	'.git',
	'node_modules',
]);


/**
 * The result of a scan, including what it could NOT see.
 *
 * `incomplete` lists the project-relative directories (with a trailing slash,
 * or '' for the whole project) whose listing failed. That distinction is load
 * bearing for snapshots: a file that was not listed because its directory
 * could not be read is not a deleted file, and treating it as one recorded
 * deletions that a later restore would then carry out on a perfectly healthy
 * file.
 */
export interface SnapshotScan {
	files: string[];
	incomplete: string[];
}

export interface SnapshotScanOptions {
	/**
	 * Skip generated directories (dependency stores, build output, caches) in
	 * projects that have no git to say what is ignored. Uses the same layered
	 * policy as the file watcher, so the two agree on what "generated" means.
	 * Git projects are unaffected: `.gitignore` is the authority there.
	 */
	pruneGenerated?: boolean;
}

/**
 * Get list of snapshot-eligible files using git (preferred) or manual scan.
 * Returns full absolute paths. Unreadable parts are silently left out — use
 * {@link scanSnapshotFiles} when the difference between "absent" and "not
 * seen" matters.
 */
export async function getSnapshotFiles(projectPath: string): Promise<string[]> {
	return (await scanSnapshotFiles(projectPath)).files;
}

/** Scan snapshot-eligible files and report which parts could not be read. */
export async function scanSnapshotFiles(
	projectPath: string,
	options: SnapshotScanOptions = {}
): Promise<SnapshotScan> {
	// Try git-based scan first (handles all .gitignore rules perfectly)
	const gitScan = await scanWithGit(projectPath);
	if (gitScan !== null) {
		return gitScan;
	}

	// Fallback: manual scan with .gitignore parsing
	return scanWithGitignoreParsing(projectPath, options);
}

// ============================================================================
// Strategy 1: Git-based scanning
// ============================================================================

async function scanWithGit(dirPath: string): Promise<SnapshotScan | null> {
	// Check if this is a git repo
	try {
		await fs.access(path.join(dirPath, '.git'));
	} catch {
		return null;
	}

	let files: string[];
	try {
		// Scan the outer repo
		files = await scanSingleGitRepo(dirPath);
	} catch (err) {
		// Deliberately NOT a fallback to the manual scan: its ignore semantics
		// differ from git's, so switching strategy mid-session would report
		// every file the two disagree on as added or deleted.
		debug.warn('snapshot', 'git ls-files failed for the project root:', err);
		return { files: [], incomplete: [''] };
	}

	// Find and scan nested git repos — separate repositories living inside
	// the project (e.g. a theme extracted into its own repo). The parent
	// repo's `git ls-files --exclude-standard` skips these because git treats
	// a nested repo as a single gitlink entry (or excludes it entirely when
	// it's listed in the parent's .gitignore). Without this step, files
	// inside nested repos are invisible to the snapshot system, so AI
	// changes to them never appear in the checkpoint banner.
	const nested = await findAndScanNestedRepos(dirPath);

	const allFiles = [...files, ...nested.files];
	debug.log('snapshot', `Git scan found ${allFiles.length} files (${files.length} outer, ${nested.files.length} nested)`);
	return { files: allFiles, incomplete: nested.incomplete };
}

/**
 * Run `git ls-files -z -co --exclude-standard` in a single git repo and return
 * absolute paths. Used for both the outer repo and nested repos.
 *
 * Throws when git cannot answer. An empty list would be indistinguishable from
 * a repository whose every file was just deleted.
 */
async function scanSingleGitRepo(dirPath: string): Promise<string[]> {
	// -z: without it git C-quotes any path with a non-ASCII byte
	// ("caf\303\251.ts"), which then names no file on disk.
	const result = await execGit(['ls-files', '-z', '-co', '--exclude-standard'], dirPath, 60_000);
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files exited ${result.exitCode}: ${result.stderr.trim()}`);
	}

	const files: string[] = [];
	for (const relativePath of result.stdout.split('\0')) {
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
}

/** A directory as an `incomplete` entry: project-relative, trailing slash. */
function incompleteEntry(rootPath: string, dirPath: string): string {
	const relative = path.relative(rootPath, dirPath).replace(/\\/g, '/');
	return relative ? `${relative}/` : '';
}

/**
 * Scan every nested git repo inside the project and return their files.
 * Discovery is delegated to `findNestedRepoPaths` — the same source of truth
 * the Git panel uses — so a repo the panel shows is a repo the snapshot
 * captures, and a package-manager checkout neither of them touches. Each repo
 * is then scanned with its own `git ls-files --exclude-standard`, which applies
 * that repo's .gitignore rules.
 */
async function findAndScanNestedRepos(rootPath: string): Promise<SnapshotScan> {
	const files: string[] = [];
	const incomplete: string[] = [];
	for (const repoPath of await findNestedRepoPaths(rootPath)) {
		try {
			files.push(...await scanSingleGitRepo(repoPath));
		} catch (err) {
			debug.warn('snapshot', `git ls-files failed for nested repo ${repoPath}:`, err);
			incomplete.push(incompleteEntry(rootPath, repoPath));
		}
	}
	return { files, incomplete };
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
async function scanWithGitignoreParsing(
	projectPath: string,
	options: SnapshotScanOptions
): Promise<SnapshotScan> {
	const files: string[] = [];
	const incomplete: string[] = [];
	const filter = new GitignoreFilter();

	// Load root .gitignore
	await filter.loadFromFile(path.join(projectPath, '.gitignore'), '');

	const scan = async (currentPath: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await fs.readdir(currentPath, { withFileTypes: true });
		} catch (err) {
			debug.warn('snapshot', `Could not read directory ${currentPath}:`, err);
			incomplete.push(incompleteEntry(projectPath, currentPath));
			return;
		}

		const relativeDir = path.relative(projectPath, currentPath).replace(/\\/g, '/');
		const names = entries.map((entry) => entry.name);

		// A directory that declares itself generated (a virtualenv, a cache
		// with CACHEDIR.TAG) is skipped whole, whatever it is called.
		if (options.pruneGenerated && relativeDir && hasGeneratedSignature(names)) return;

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
				let isNestedRepo = false;
				try {
					await fs.access(path.join(fullPath, '.git'));
					isNestedRepo = true;
				} catch {
					// Not a git repo — apply gitignore filter and recurse
				}
				if (isNestedRepo) {
					try {
						files.push(...await scanSingleGitRepo(fullPath));
					} catch (err) {
						debug.warn('snapshot', `git ls-files failed for nested repo ${fullPath}:`, err);
						incomplete.push(incompleteEntry(projectPath, fullPath));
					}
					continue;
				}

				if (options.pruneGenerated && (isIgnoredName(entry.name) || isMarkedOutputDir(entry.name, names))) {
					continue;
				}

				if (!filter.isIgnored(relativePath, true)) {
					await scan(fullPath);
				}
			} else if (entry.isFile()) {
				if (options.pruneGenerated && isIgnoredName(entry.name)) continue;
				if (!filter.isIgnored(relativePath, false)) {
					files.push(fullPath);
				}
			}
		}
	};

	await scan(projectPath);
	debug.log('snapshot', `Manual scan found ${files.length} files`);
	return { files, incomplete };
}
