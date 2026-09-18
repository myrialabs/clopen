/**
 * Address comparison for preview tabs.
 *
 * The two ends of a preview tab hold different spellings of one address: the
 * frontend keeps what the user typed ("localhost:3000"), the backend keeps
 * where the navigation landed ("http://localhost:3000/"), possibly after a
 * redirect. Anything that has to decide whether a slot and a backend tab are
 * the same tab has to bridge that gap.
 */

function normalize(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^https?:\/\//, '')
		.replace(/\/+$/, '');
}

/**
 * Whether two addresses refer to the same preview target.
 *
 * Deliberately loose about scheme and trailing slash, and it accepts one
 * address being a path-prefix of the other — a tab opened at the root that
 * redirected to `/login` is still that tab. Deliberately strict about the
 * host and port, which are what actually distinguish one dev server from the
 * next; `localhost:3000` and `localhost:3001` must never be confused.
 */
export function sameTabTarget(a: string, b: string): boolean {
	const left = normalize(a);
	const right = normalize(b);
	if (!left || !right) return false;

	return left === right || right.startsWith(`${left}/`) || left.startsWith(`${right}/`);
}
