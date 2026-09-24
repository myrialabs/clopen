/**
 * Pure explorer keyboard-navigation helpers.
 *
 * The file tree has no virtualized list and no global key router: these
 * functions compute WHERE a navigation key should land, while the panel
 * (`FilesPanel.svelte`) owns focus, selection state and scrolling. Keeping
 * the index math pure makes ArrowUp/ArrowDown/Home/End/PageUp/PageDown
 * unit-testable without a DOM.
 */

export type TreeNavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

/** Row height estimate (px) used to convert a viewport into a page step. */
export const TREE_NAV_ROW_HEIGHT_PX = 30;

/** Fallback page step when the container height cannot be measured. */
export const TREE_NAV_FALLBACK_PAGE_SIZE = 10;

/**
 * Next row index for a navigation key, clamped to `[0, total - 1]`.
 * Page keys move by `pageSize` rows (at least 1); unknown keys hold position.
 */
export function computeNavIndex(
	current: number,
	total: number,
	key: string,
	pageSize: number
): number {
	if (total <= 0) return -1;
	const cur = Math.min(Math.max(current, 0), total - 1);
	const step = Math.max(1, Math.floor(pageSize) || 1);
	switch (key) {
		case 'ArrowUp':
			return Math.max(0, cur - 1);
		case 'ArrowDown':
			return Math.min(total - 1, cur + 1);
		case 'Home':
			return 0;
		case 'End':
			return total - 1;
		case 'PageUp':
			return Math.max(0, cur - step);
		case 'PageDown':
			return Math.min(total - 1, cur + step);
		default:
			return cur;
	}
}

/**
 * How many rows fit in the visible tree viewport. Falls back to
 * `TREE_NAV_FALLBACK_PAGE_SIZE` when the height is not measurable, so
 * PageUp/PageDown always move by a sane amount.
 */
export function estimatePageSize(containerHeight: number, rowHeight: number = TREE_NAV_ROW_HEIGHT_PX): number {
	if (!Number.isFinite(containerHeight) || containerHeight <= 0) return TREE_NAV_FALLBACK_PAGE_SIZE;
	const row = rowHeight > 0 ? rowHeight : TREE_NAV_ROW_HEIGHT_PX;
	return Math.max(1, Math.floor(containerHeight / row));
}

/**
 * How a navigation key treats the selection:
 * - `collapse`: selection becomes the landed item alone (plain moves);
 * - `focus-only`: only the focus cursor advances — a standing selection is
 *   preserved untouched, so no highlight appears, moves, or vanishes;
 * - `range`: contiguous block from the anchor to the landed item.
 */
export type NavSelectionMode = 'collapse' | 'focus-only' | 'range';

/**
 * Decision table for navigation keys (Windows Explorer parity + paging
 * preservation rule):
 * - Shift (with or without Ctrl) always ranges from the anchor;
 * - Ctrl moves the focus cursor only;
 * - plain PageUp/PageDown on a multi-selection moves the focus cursor only
 *   so paging never wipes what was selected — on a single selection it
 *   collapses like the arrows;
 * - anything else plain collapses onto the landed item.
 */
export function navSelectionMode(
	modifiers: { shift: boolean; ctrl: boolean },
	isPageKey: boolean,
	selectedCount: number
): NavSelectionMode {
	if (modifiers.shift) return 'range';
	if (modifiers.ctrl) return 'focus-only';
	if (isPageKey && selectedCount > 1) return 'focus-only';
	return 'collapse';
}

/**
 * Contiguous Explorer-order slice from `anchor` to `target` (either
 * direction), used by Shift+click and Shift+arrows. Folders and files are
 * equal items — order is whatever the visible row order is. When either end
 * is not visible, falls back to the target alone.
 */
export function sliceRange(visible: string[], anchor: string, target: string): string[] {
	const i1 = visible.indexOf(anchor);
	const i2 = visible.indexOf(target);
	if (i1 === -1 || i2 === -1) return [target];
	const start = Math.min(i1, i2);
	const end = Math.max(i1, i2);
	return visible.slice(start, end + 1);
}

/**
 * Resolve the range anchor for a Shift+navigation step, in priority order:
 * the stored anchor, the focus cursor (the clicked/focused item), any
 * currently selected visible item, then the given fallback. This guarantees
 * the Shift+Down-after-click invariant: the clicked item is always part of
 * the resulting block — it can never end up as a bare cursor without
 * selection, no matter which of the inputs went stale first. The caller
 * persists the returned anchor back to state.
 */
export function resolveShiftAnchor(
	visible: string[],
	selectionAnchor: string | null,
	cursorPath: string | null,
	selectedPaths: string[],
	fallback: string
): string {
	if (selectionAnchor && visible.includes(selectionAnchor)) return selectionAnchor;
	if (cursorPath && visible.includes(cursorPath)) return cursorPath;
	for (const p of selectedPaths) {
		if (visible.includes(p)) return p;
	}
	return fallback;
}

/**
 * Reveal a row inside its own scroll container without touching any
 * ancestor. Unlike `scrollIntoView`, only `scroller.scrollTop` is adjusted,
 * so the sidebar, panels and page never move — the active item can neither
 * jump nor vanish. `padding` keeps a small context margin at the container
 * edges. Same math as the panel's scroll-to-active helper.
 */
export function ensureRowVisible(scroller: HTMLElement, row: HTMLElement, padding = 4): void {
	const containerRect = scroller.getBoundingClientRect();
	const elRect = row.getBoundingClientRect();
	if (elRect.top < containerRect.top + padding) {
		scroller.scrollTop -= containerRect.top + padding - elRect.top;
	} else if (elRect.bottom > containerRect.bottom - padding) {
		scroller.scrollTop += elRect.bottom - containerRect.bottom + padding;
	}
}
