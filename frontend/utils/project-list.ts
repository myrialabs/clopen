/**
 * Pure list math behind the sidebar's Selection Mode, pins, and archive.
 *
 * Kept out of the `.svelte.ts` store so the branching here is testable without
 * a Svelte runtime: every function takes the current id arrays and returns new
 * ones, never mutating its inputs. The store owns the reactive state and does
 * nothing but hold the result of these calls.
 */

/** Drop empties and duplicates, preserving first-seen order. */
export function cleanIds(ids: (string | undefined | null)[]): string[] {
	return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}

/** Add the id when absent, remove it when present. */
export function toggleId(ids: string[], id: string): string[] {
	return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}

/**
 * True only when every visible row is picked. An empty list is NOT "all
 * selected" — otherwise the header checkbox renders checked over nothing.
 */
export function areAllOf(selected: string[], visible: (string | undefined)[]): boolean {
	const clean = cleanIds(visible);
	if (clean.length === 0) return false;
	return clean.every((id) => selected.includes(id));
}

/**
 * Select All is a toggle, not a one-way switch: partial or empty selects the
 * visible rows, fully-selected clears them. Returning the visible set (rather
 * than merging into `selected`) is what keeps the counter and the rows in
 * agreement — the old behavior re-selected everything on uncheck and left the
 * counter stale at N/N.
 */
export function toggleAllOf(selected: string[], visible: (string | undefined)[]): string[] {
	return areAllOf(selected, visible) ? [] : cleanIds(visible);
}

/**
 * Keep only picks that are still in the visible list. Searching narrows what
 * the toolbar counts against, so without this the counter reads "4/1" and a
 * bulk action reaches projects the user can no longer see.
 */
export function retainIds(selected: string[], visible: (string | undefined)[]): string[] {
	const allowed = new Set(cleanIds(visible));
	return selected.filter((id) => allowed.has(id));
}

/**
 * Pinned first, stored order preserved within each group. `sort` is stable in
 * every engine this runs on, so equal-rank entries keep their drag-and-drop
 * order — pinning must not reshuffle the rest of the list.
 */
export function sortPinnedFirst<T extends { id: string }>(items: T[], pinned: string[]): T[] {
	return [...items].sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)));
}

/** Ids from `incoming` that are not already archived, deduplicated. */
export function newlyArchived(archived: string[], incoming: (string | undefined)[]): string[] {
	return cleanIds(incoming).filter((id) => !archived.includes(id));
}
