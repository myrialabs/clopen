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

/**
 * Safety-net directories to always exclude regardless of .gitignore.
 * These are never useful in snapshots and could be massive.
 */
const ALWAYS_EXCLUDE_DIRS = new Set([
	'.git',
	'node_modules',
]);

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
		const proc = Bun.spawn(
			['git', 'ls-files', '-co', '--exclude-standard'],
			{ cwd: dirPath, stdout: 'pipe', stderr: 'pipe' }
		);

		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) return null;

		const files: string[] = [];
		for (const line of output.split('\n')) {
			const relativePath = line.trim();
			if (!relativePath) continue;

			// Skip always-excluded directories
			const firstSegment = relativePath.split('/')[0];
			if (ALWAYS_EXCLUDE_DIRS.has(firstSegment)) continue;

			files.push(path.join(dirPath, relativePath));
		}

		debug.log('snapshot', `Git scan found ${files.length} files`);
		return files;
	} catch (err) {
		debug.warn('snapshot', 'git ls-files failed, falling back to manual scan:', err);
		return null;
	}
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
