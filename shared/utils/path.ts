/**
 * Shared path utilities.
 * - normalizePath / pathsEqual / getRelativePath: forward-slash display/comparison
 * - resolveOsPath: OS-native absolute path for subprocess cwd
 */

import { resolve } from 'path';

/**
 * Normalize path separators to forward slash and strip trailing slashes.
 * Keeps trailing slash only for drive roots like "C:/".
 */
export function normalizePath(p: string): string {
	let n = p.replace(/\\/g, '/');
	// Keep trailing slash only for drive roots like "C:/"
	if (n.length > 1 && !n.match(/^[A-Za-z]:\/$/)) {
		n = n.replace(/\/+$/, '');
	}
	return n;
}

/**
 * Compare two paths, case-insensitively on Windows paths.
 */
export function pathsEqual(a: string, b: string): boolean {
	const na = normalizePath(a);
	const nb = normalizePath(b);
	if (/^[A-Za-z]:/.test(na) || /^[A-Za-z]:/.test(nb)) {
		return na.toLowerCase() === nb.toLowerCase();
	}
	return na === nb;
}

/**
 * Get relative path from a base path, normalized with forward slashes.
 */
export function getRelativePath(fullPath: string, basePath: string): string {
	const normalizedFull = normalizePath(fullPath);
	const normalizedBase = normalizePath(basePath);

	if (normalizedFull.startsWith(normalizedBase)) {
		let rel = normalizedFull.slice(normalizedBase.length);
		if (rel.startsWith('/')) {
			rel = rel.slice(1);
		}
		return rel;
	}

	return normalizePath(fullPath);
}

/**
 * Resolve a path to an OS-native absolute path.
 * On Windows: resolves relative paths, prepends drive letter, converts to backslashes.
 * On POSIX: returns path as-is (already absolute from OS perspective).
 *
 * Use this when passing paths to subprocess cwd / SDK options.
 */
export function resolveOsPath(projectPath: string): string {
	let resolved = projectPath;

	if (process.platform === 'win32') {
		if (!projectPath.match(/^[A-Za-z]:\\/)) {
			if (projectPath.startsWith('\\')) {
				const currentDrive = process.cwd().substring(0, 2);
				resolved = currentDrive + projectPath;
			} else {
				resolved = resolve(projectPath);
			}
		}
		resolved = resolved.replace(/\//g, '\\');
	}

	return resolved;
}
