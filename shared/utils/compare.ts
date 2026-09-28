/**
 * Natural-order comparator for human-facing file, path, and name lists.
 *
 * The collator is pinned to `en` so every runtime and platform agrees on one
 * order: the Bun backend and the browser frontend both sort the same lists, and
 * their ambient locales differ (a Czech or Swedish browser, a container with no
 * LANG). `localeCompare(x, undefined, …)` follows the ambient locale instead,
 * so it can re-order a list the other side already sorted.
 *
 * `sensitivity: 'base'` keeps case and diacritics out of the ordering, which
 * makes names like `README.md` and `readme.md` compare equal — the code-unit
 * tie-break then decides that pair deterministically, because leaving it to
 * sort stability would fall back to readdir order, which differs per filesystem.
 */
const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
	const result = naturalCollator.compare(a, b);
	if (result !== 0) return result;
	return a < b ? -1 : a > b ? 1 : 0;
}
