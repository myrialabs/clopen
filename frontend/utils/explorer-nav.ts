/**
 * Pure explorer keyboard-navigation helpers.
 *
 * The file tree has no virtualized list and no global key router: these
 * functions compute WHERE a navigation key should land, while the panel
 * (`FilesPanel.svelte`) owns focus, selection state and scrolling. Keeping
 * the index math pure makes ArrowUp/ArrowDown/Home/End unit-testable without
 * a DOM.
 *
 * PageUp/PageDown are deliberately NOT handled: rows are focusable and live
 * inside the tree's own scroll container, so the native page-scroll already
 * does the right thing there. Moving the cursor without disturbing a
 * multi-selection is covered by Ctrl+arrows (focus only) plus Space/Shift.
 */

export type TreeNavKey = 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

/**
 * Next row index for a navigation key, clamped to `[0, total - 1]`.
 * Unknown keys hold position.
 */
export function computeNavIndex(current: number, total: number, key: string): number {
	if (total <= 0) return -1;
	const cur = Math.min(Math.max(current, 0), total - 1);
	switch (key) {
		case 'ArrowUp':
			return Math.max(0, cur - 1);
		case 'ArrowDown':
			return Math.min(total - 1, cur + 1);
		case 'Home':
			return 0;
		case 'End':
			return total - 1;
		default:
			return cur;
	}
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
 * Decision table for navigation keys (Windows Explorer parity):
 * - Shift (with or without Ctrl) always ranges from the anchor;
 * - Ctrl moves the focus cursor only, leaving the selection intact;
 * - anything else plain collapses onto the landed item.
 */
export function navSelectionMode(modifiers: { shift: boolean; ctrl: boolean }): NavSelectionMode {
	if (modifiers.shift) return 'range';
	if (modifiers.ctrl) return 'focus-only';
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
 *
 * Membership goes through a Set: a large selection in a large tree would
 * otherwise cost one full array scan per selected path on every keypress.
 */
export function resolveShiftAnchor(
	visible: string[],
	selectionAnchor: string | null,
	cursorPath: string | null,
	selectedPaths: string[],
	fallback: string
): string {
	const isVisible = new Set(visible);
	if (selectionAnchor && isVisible.has(selectionAnchor)) return selectionAnchor;
	if (cursorPath && isVisible.has(cursorPath)) return cursorPath;
	for (const p of selectedPaths) {
		if (isVisible.has(p)) return p;
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
