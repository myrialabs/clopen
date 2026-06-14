import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { join, extname, basename, relative } from 'path';
import { readdir } from 'fs/promises';
import { requireProjectPathAccess } from './path-access';
import { validateFileSize } from '../../files/file-size-limit';

// Heuristic patterns that indicate potential ReDoS risk:
// 1. Nested quantifiers: (a+)+, (.*)+, (a*)*,  (x{1,5})+
// 2. Alternation (with OR without quantifiers inside) under quantifier: (a|aa)+, (foo|foobar)+, (.*)+
// 3. Character classes with adjacent quantifiers: [a-z]*[a-z]+
const REDOS_PATTERNS = [
	/\(.*[+*?{].*\)[+*?{]/,          // nested quantifiers like (a+)+, (.*)+, or (x{1,5})+
	/\([^)]*\|[^)]*\)[+*?{]/,        // ANY alternation under quantifier: (a|aa)+, (foo|bar)+
	/\[[^\]]+\]\s*[+*?]\s*\[[^\]]+\]\s*[+*?]/,  // adjacent char-class quantifiers
];

// Maximum execution time for regex test (milliseconds)
const REGEX_TIMEOUT_MS = 100;

export function createSafeRegex(pattern: string, flags: string): RegExp | null {
	// Check against ReDoS heuristics
	for (const heuristic of REDOS_PATTERNS) {
		if (heuristic.test(pattern)) {
			debug.warn('file', 'ReDoS-risk pattern rejected:', pattern);
			return null;
		}
	}

	let regex: RegExp;
	try {
		regex = new RegExp(pattern, flags);
	} catch (error) {
		debug.warn('file', 'Invalid regex pattern:', pattern);
		return null;
	}

	// Test execution time with a worst-case string to detect catastrophic backtracking
	const testString = 'a'.repeat(50); // 50-char string of 'a'
	const startTime = Date.now();
	try {
		regex.test(testString);
		const elapsed = Date.now() - startTime;
		if (elapsed > REGEX_TIMEOUT_MS) {
			debug.warn('file', `ReDoS-risk pattern rejected (execution timeout: ${elapsed}ms):`, pattern);
			return null;
		}
	} catch (error) {
		debug.warn('file', 'Regex execution error:', pattern, error);
		return null;
	}

	return regex;
}

// Directories to skip during search
const SKIP_DIRS = new Set([
	'node_modules', '.git', '.svelte-kit', 'build', 'dist', 'coverage',
	'.next', '.nuxt', 'target', '.cache', '.output', '__pycache__',
	'.venv', 'venv', '.tox', '.eggs', '.mypy_cache', 'vendor',
	'.idea', '.vscode', '.DS_Store', '.svn', '.hg'
]);

// Binary file extensions to skip in code search
const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
	'.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
	'.exe', '.dll', '.so', '.dylib', '.bin',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.mp3', '.mp4', '.wav', '.avi', '.mkv', '.flv',
	'.sqlite', '.db', '.lock'
]);

// Async generator to walk files recursively, skipping ignored directories
async function* walkFiles(dir: string, maxDepth = 10, depth = 0): AsyncGenerator<string> {
	if (depth >= maxDepth) return;

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (SKIP_DIRS.has(entry.name)) continue;

		const fullPath = join(dir, entry.name);

		if (entry.isFile()) {
			yield fullPath;
		} else if (entry.isDirectory()) {
			yield* walkFiles(fullPath, maxDepth, depth + 1);
		}
	}
}

// Parse filter patterns (comma-separated)
function parseFilterPattern(pattern?: string): string[] {
	if (!pattern) return [];
	return pattern.split(',').map(s => s.trim()).filter(Boolean);
}

// Check if a file matches include/exclude filter patterns
function matchesFilter(relativePath: string, includes: string[], excludes: string[]): boolean {
	// Normalize path separators
	const normalized = relativePath.replace(/\\/g, '/');

	// If includes are specified, file must match at least one
	if (includes.length > 0) {
		const matched = includes.some(pattern => {
			const p = pattern.replace(/\\/g, '/');
			// Directory prefix match
			if (p.endsWith('/') || (!p.includes('*') && !p.includes('.'))) {
				const dirPrefix = p.endsWith('/') ? p : p + '/';
				return normalized.startsWith(dirPrefix) || normalized.startsWith('./' + dirPrefix);
			}
			// Glob-like pattern (e.g., *.ts)
			if (p.startsWith('*.')) {
				return normalized.endsWith(p.slice(1));
			}
			// Exact or contains match
			return normalized.includes(p);
		});
		if (!matched) return false;
	}

	// If excludes are specified, file must not match any
	if (excludes.length > 0) {
		const excluded = excludes.some(pattern => {
			const p = pattern.replace(/\\/g, '/');
			if (p.endsWith('/') || (!p.includes('*') && !p.includes('.'))) {
				const dirPrefix = p.endsWith('/') ? p : p + '/';
				return normalized.startsWith(dirPrefix);
			}
			if (p.startsWith('*.')) {
				return normalized.endsWith(p.slice(1));
			}
			return normalized.includes(p);
		});
		if (excluded) return false;
	}

	return true;
}

// Search files by name
interface FileSearchResult {
	name: string;
	path: string;
	relativePath: string;
	type: 'file';
	size: number;
	modified: any;
}

async function searchFilesByName(projectPath: string, query: string): Promise<FileSearchResult[]> {
	const results: FileSearchResult[] = [];
	const queryLower = query.toLowerCase();

	try {
		for await (const filePath of walkFiles(projectPath)) {
			const fileName = basename(filePath);

			// Case-insensitive name match
			if (fileName.toLowerCase().includes(queryLower)) {
				try {
					const fileObj = Bun.file(filePath);
					const stat = await fileObj.stat();
					results.push({
						name: fileName,
						path: filePath,
						relativePath: relative(projectPath, filePath).replace(/\\/g, '/'),
						type: 'file',
						size: stat.size,
						modified: stat.mtime
					});

					// Limit results
					if (results.length >= 100) break;
				} catch {
					continue;
				}
			}
		}
	} catch (error) {
		debug.error('file', 'Error searching files:', error);
	}

	return results;
}

// Search code content
interface CodeMatch {
	line: number;
	text: string;
	column: number;
	length: number;
}

interface CodeSearchResult {
	file: string;
	relativePath: string;
	matches: CodeMatch[];
	totalMatches: number;
}

async function searchCodeContent(
	projectPath: string,
	query: string,
	options: {
		caseSensitive?: boolean;
		wholeWord?: boolean;
		useRegex?: boolean;
		includePattern?: string;
		excludePattern?: string;
	} = {}
): Promise<CodeSearchResult[]> {
	const {
		caseSensitive = false,
		wholeWord = false,
		useRegex = false,
		includePattern,
		excludePattern
	} = options;

	const results: CodeSearchResult[] = [];

	// Build the search regex with ReDoS protection
	let searchPattern: RegExp | null;
	if (useRegex) {
		let regexStr = query;
		if (wholeWord) regexStr = `\\b${regexStr}\\b`;
		searchPattern = createSafeRegex(regexStr, caseSensitive ? 'g' : 'gi');
	} else {
		let escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (wholeWord) escaped = `\\b${escaped}\\b`;
		try {
			searchPattern = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
		} catch (error) {
			debug.error('file', 'Invalid escaped search pattern:', error);
			return [];
		}
	}
	if (!searchPattern) return [];

	// Parse include/exclude filters
	const includes = parseFilterPattern(includePattern);
	const excludes = parseFilterPattern(excludePattern);

	try {
		for await (const filePath of walkFiles(projectPath)) {
			const ext = extname(filePath).toLowerCase();

			// Skip binary files
			if (BINARY_EXTENSIONS.has(ext)) continue;

			const relPath = relative(projectPath, filePath).replace(/\\/g, '/');

			// Apply include/exclude filters
			if (!matchesFilter(relPath, includes, excludes)) continue;

			try {
				const fileObj = Bun.file(filePath);
				const stat = await fileObj.stat();

				// Skip large files (> 1MB)
				if (stat.size > 1024 * 1024) continue;

				const content = await fileObj.text();
				const lines = content.split('\n');
				const matches: CodeMatch[] = [];

				for (let i = 0; i < lines.length; i++) {
					// Reset regex lastIndex for each line and find ALL matches
					searchPattern.lastIndex = 0;
					let match: RegExpExecArray | null;
					while ((match = searchPattern.exec(lines[i])) !== null) {
						matches.push({
							line: i + 1,
							text: lines[i].trimEnd(),
							column: match.index + 1,
							length: match[0].length
						});
						// Prevent infinite loop for zero-length matches
						if (match[0].length === 0) {
							searchPattern.lastIndex++;
						}
					}
				}

				if (matches.length > 0) {
					results.push({
						file: basename(filePath),
						relativePath: relPath,
						matches: matches.slice(0, 50),
						totalMatches: matches.length
					});
				}
			} catch {
				// Skip files that can't be read (binary, encoding issues, etc.)
				continue;
			}
		}
	} catch (error) {
		debug.error('file', 'Error searching code:', error);
	}

	return results;
}

// Replace in files
interface ReplaceResult {
	file: string;
	relativePath: string;
	replacements: number;
}

async function replaceInFiles(
	projectPath: string,
	searchQuery: string,
	replaceWith: string,
	options: {
		caseSensitive?: boolean;
		wholeWord?: boolean;
		useRegex?: boolean;
		includePattern?: string;
		excludePattern?: string;
	} = {}
): Promise<ReplaceResult[]> {
	const {
		caseSensitive = false,
		wholeWord = false,
		useRegex = false
	} = options;

	// First, find all matching files
	const searchResults = await searchCodeContent(projectPath, searchQuery, options);

	const results: ReplaceResult[] = [];

	// Build replace regex with ReDoS protection
	let pattern: RegExp | null;
	const flags = caseSensitive ? 'g' : 'gi';
	if (useRegex) {
		let regexStr = searchQuery;
		if (wholeWord) regexStr = `\\b${regexStr}\\b`;
		pattern = createSafeRegex(regexStr, flags);
	} else {
		let escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		if (wholeWord) escaped = `\\b${escaped}\\b`;
		try {
			pattern = new RegExp(escaped, flags);
		} catch (error) {
			debug.error('file', 'Invalid escaped replace pattern:', error);
			return [];
		}
	}
	if (!pattern) return [];

	for (const searchResult of searchResults) {
		const fullPath = join(projectPath, searchResult.relativePath);

		try {
			const fileObj = Bun.file(fullPath);
			const content = await fileObj.text();

			const matchCount = (content.match(pattern) || []).length;
			if (matchCount > 0) {
				const newContent = content.replace(pattern, replaceWith);
				// Replacements can balloon a file's size (e.g. short pattern → long
				// replacement). Validate post-expansion size before writing.
				validateFileSize(Buffer.byteLength(newContent, 'utf8'));
				await Bun.write(fullPath, newContent);

				results.push({
					file: basename(searchResult.relativePath),
					relativePath: searchResult.relativePath,
					replacements: matchCount
				});
			}
		} catch (error) {
			debug.error('file', `Error replacing in ${searchResult.relativePath}:`, error);
		}
	}

	return results;
}

const FileSearchResultSchema = t.Object({
	name: t.String(),
	path: t.String(),
	relativePath: t.String(),
	type: t.Literal('file'),
	size: t.Number(),
	modified: t.Date()
});

export const fileSearchHandler = createRouter()
	.http('files:search-files', {
		data: t.Object({
			project_path: t.String(),
			query: t.String()
		}),
		response: t.Array(FileSearchResultSchema)
	}, async ({ data, conn }) => {
		const { project_path, query } = data;
		const project = requireProjectPathAccess(conn, project_path);

		if (!query || query.trim().length === 0) {
			return [];
		}

		return await searchFilesByName(project.path, query);
	})
	.http('files:search-code', {
		data: t.Object({
			project_path: t.String(),
			query: t.String(),
			case_sensitive: t.Optional(t.Boolean()),
			whole_word: t.Optional(t.Boolean()),
			use_regex: t.Optional(t.Boolean()),
			include_pattern: t.Optional(t.String()),
			exclude_pattern: t.Optional(t.String())
		}),
		response: t.Array(t.Object({
			file: t.String(),
			relativePath: t.String(),
			matches: t.Array(t.Object({
				line: t.Number(),
				text: t.String(),
				column: t.Number(),
				length: t.Number()
			})),
			totalMatches: t.Number()
		}))
	}, async ({ data, conn }) => {
		const {
			project_path,
			query,
			case_sensitive = false,
			whole_word = false,
			use_regex = false,
			include_pattern,
			exclude_pattern
		} = data;
		const project = requireProjectPathAccess(conn, project_path);

		if (!query || query.trim().length === 0) {
			return [];
		}

		return await searchCodeContent(project.path, query, {
			caseSensitive: case_sensitive,
			wholeWord: whole_word,
			useRegex: use_regex,
			includePattern: include_pattern,
			excludePattern: exclude_pattern
		});
	})
	.http('files:replace-in-files', {
		data: t.Object({
			project_path: t.String(),
			search_query: t.String(),
			replace_with: t.String(),
			case_sensitive: t.Optional(t.Boolean()),
			whole_word: t.Optional(t.Boolean()),
			use_regex: t.Optional(t.Boolean()),
			include_pattern: t.Optional(t.String()),
			exclude_pattern: t.Optional(t.String())
		}),
		response: t.Object({
			results: t.Array(t.Object({
				file: t.String(),
				relativePath: t.String(),
				replacements: t.Number()
			})),
			totalReplacements: t.Number(),
			totalFiles: t.Number()
		})
	}, async ({ data, conn }) => {
		const {
			project_path,
			search_query,
			replace_with,
			case_sensitive = false,
			whole_word = false,
			use_regex = false,
			include_pattern,
			exclude_pattern
		} = data;
		const project = requireProjectPathAccess(conn, project_path);

		if (!search_query || search_query.trim().length === 0) {
			return { results: [], totalReplacements: 0, totalFiles: 0 };
		}

		const results = await replaceInFiles(project.path, search_query, replace_with, {
			caseSensitive: case_sensitive,
			wholeWord: whole_word,
			useRegex: use_regex,
			includePattern: include_pattern,
			excludePattern: exclude_pattern
		});

		const totalReplacements = results.reduce((sum, r) => sum + r.replacements, 0);

		return {
			results,
			totalReplacements,
			totalFiles: results.length
		};
	});
