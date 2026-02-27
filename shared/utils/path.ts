/**
 * Shared path normalization utilities.
 * Normalizes path separators to forward slashes for consistent display and comparison.
 */

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
