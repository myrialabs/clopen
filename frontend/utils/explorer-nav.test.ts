/**
 * Explorer tree keyboard-navigation math.
 *
 * Guards the PageUp/PageDown (plus ArrowUp/ArrowDown/Home/End) contract:
 * - navigation moves within the visible rows and clamps at the ends;
 * - PageUp/PageDown move by a full viewport page, never by a single row and
 *   never past the first/last row;
 * - the page size derives from the measured container height with a sane
 *   fallback, so the keys work on desktop and on small/responsive viewports.
 */

import { describe, it, expect } from 'bun:test';

import {
	computeNavIndex,
	ensureRowVisible,
	estimatePageSize,
	navSelectionMode,
	resolveShiftAnchor,
	sliceRange,
	TREE_NAV_FALLBACK_PAGE_SIZE
} from './explorer-nav';

describe('computeNavIndex', () => {
	it('moves one row with ArrowUp/ArrowDown', () => {
		expect(computeNavIndex(5, 20, 'ArrowDown', 10)).toBe(6);
		expect(computeNavIndex(5, 20, 'ArrowUp', 10)).toBe(4);
	});

	it('clamps at the first and last row', () => {
		expect(computeNavIndex(0, 20, 'ArrowUp', 10)).toBe(0);
		expect(computeNavIndex(19, 20, 'ArrowDown', 10)).toBe(19);
	});

	it('jumps to the ends with Home/End', () => {
		expect(computeNavIndex(7, 20, 'Home', 10)).toBe(0);
		expect(computeNavIndex(7, 20, 'End', 10)).toBe(19);
	});

	it('moves a full page with PageDown/PageUp', () => {
		expect(computeNavIndex(2, 50, 'PageDown', 10)).toBe(12);
		expect(computeNavIndex(12, 50, 'PageUp', 10)).toBe(2);
	});

	it('clamps pages at the list ends instead of overshooting', () => {
		expect(computeNavIndex(45, 50, 'PageDown', 10)).toBe(49);
		expect(computeNavIndex(3, 50, 'PageUp', 10)).toBe(0);
	});

	it('treats a page smaller than 1 as a single row', () => {
		expect(computeNavIndex(5, 20, 'PageDown', 0)).toBe(6);
		expect(computeNavIndex(5, 20, 'PageUp', -3)).toBe(4);
	});

	it('holds position for unrelated keys', () => {
		expect(computeNavIndex(5, 20, 'Enter', 10)).toBe(5);
		expect(computeNavIndex(5, 20, 'c', 10)).toBe(5);
	});

	it('reports -1 for an empty list', () => {
		expect(computeNavIndex(0, 0, 'PageDown', 10)).toBe(-1);
	});

	it('clamps an out-of-range start index before moving', () => {
		expect(computeNavIndex(99, 20, 'ArrowDown', 10)).toBe(19);
		expect(computeNavIndex(-4, 20, 'ArrowUp', 10)).toBe(0);
	});
});

describe('estimatePageSize', () => {
	it('derives the page from the container height', () => {
		expect(estimatePageSize(300, 30)).toBe(10);
		expect(estimatePageSize(320, 32)).toBe(10);
	});

	it('never drops below a single row', () => {
		expect(estimatePageSize(10, 30)).toBe(1);
	});

	it('falls back when the height cannot be measured', () => {
		expect(estimatePageSize(0)).toBe(TREE_NAV_FALLBACK_PAGE_SIZE);
		expect(estimatePageSize(-5)).toBe(TREE_NAV_FALLBACK_PAGE_SIZE);
		expect(estimatePageSize(Number.NaN)).toBe(TREE_NAV_FALLBACK_PAGE_SIZE);
	});
});

describe('sliceRange', () => {
	// Explorer display order: folders and files are equal items.
	const visible = ['/p/guru', '/p/guru/a.png', '/p/guru/b.png', '/p/rapor', '/p/rapor/c.png'];

	it('covers anchor-to-target forward', () => {
		expect(sliceRange(visible, '/p/guru/a.png', '/p/rapor')).toEqual([
			'/p/guru/a.png',
			'/p/guru/b.png',
			'/p/rapor'
		]);
	});

	it('covers target-to-anchor backward', () => {
		expect(sliceRange(visible, '/p/rapor/c.png', '/p/guru')).toEqual(visible);
	});

	it('returns a single item when anchor equals target', () => {
		expect(sliceRange(visible, '/p/rapor', '/p/rapor')).toEqual(['/p/rapor']);
	});

	it('falls back to the target when an end is not visible', () => {
		expect(sliceRange(visible, '/p/missing', '/p/rapor')).toEqual(['/p/rapor']);
		expect(sliceRange(visible, '/p/guru', '/p/missing')).toEqual(['/p/missing']);
		expect(sliceRange([], '/p/guru', '/p/rapor')).toEqual(['/p/rapor']);
	});
});

describe('navSelectionMode', () => {
	it('collapses on plain arrows (single or empty selection)', () => {
		expect(navSelectionMode({ shift: false, ctrl: false }, false, 0)).toBe('collapse');
		expect(navSelectionMode({ shift: false, ctrl: false }, false, 1)).toBe('collapse');
	});

	it('collapses on plain arrows even with a multi-selection (Explorer parity)', () => {
		expect(navSelectionMode({ shift: false, ctrl: false }, false, 3)).toBe('collapse');
	});

	it('moves focus only on plain PageUp/PageDown over a multi-selection', () => {
		// Paging must never wipe what was selected.
		expect(navSelectionMode({ shift: false, ctrl: false }, true, 2)).toBe('focus-only');
		expect(navSelectionMode({ shift: false, ctrl: false }, true, 5)).toBe('focus-only');
	});

	it('collapses on plain PageUp/PageDown over a single selection', () => {
		expect(navSelectionMode({ shift: false, ctrl: false }, true, 1)).toBe('collapse');
		expect(navSelectionMode({ shift: false, ctrl: false }, true, 0)).toBe('collapse');
	});

	it('moves focus only on Ctrl+navigation regardless of selection size', () => {
		expect(navSelectionMode({ shift: false, ctrl: true }, false, 1)).toBe('focus-only');
		expect(navSelectionMode({ shift: false, ctrl: true }, false, 4)).toBe('focus-only');
		expect(navSelectionMode({ shift: false, ctrl: true }, true, 4)).toBe('focus-only');
	});

	it('ranges on Shift+navigation (with or without Ctrl)', () => {
		expect(navSelectionMode({ shift: true, ctrl: false }, false, 1)).toBe('range');
		expect(navSelectionMode({ shift: true, ctrl: true }, false, 3)).toBe('range');
		expect(navSelectionMode({ shift: true, ctrl: false }, true, 3)).toBe('range');
	});
});

describe('resolveShiftAnchor', () => {
	const visible = ['/p/composer.json', '/p/composer.lock', '/p/daftar.php'];

	it('prefers the stored anchor when visible', () => {
		expect(resolveShiftAnchor(visible, '/p/composer.json', '/p/daftar.php', [], visible[0])).toBe(
			'/p/composer.json'
		);
	});

	it('falls back to the clicked/focused cursor when the anchor is stale', () => {
		// Regression: Shift+Down right after clicking composer.json must keep
		// composer.json in the block even if the stored anchor went stale —
		// the clicked item must never end up a bare cursor without selection.
		expect(resolveShiftAnchor(visible, null, '/p/composer.json', [], visible[0])).toBe(
			'/p/composer.json'
		);
		expect(resolveShiftAnchor(visible, '/p/gone', '/p/composer.json', [], visible[0])).toBe(
			'/p/composer.json'
		);
	});

	it('falls back to a selected visible item when anchor and cursor are stale', () => {
		expect(
			resolveShiftAnchor(visible, null, null, ['/p/daftar.php', '/p/gone'], visible[0])
		).toBe('/p/daftar.php');
	});

	it('falls back to the given fallback when nothing usable exists', () => {
		expect(resolveShiftAnchor(visible, null, null, [], visible[0])).toBe('/p/composer.json');
		expect(resolveShiftAnchor([], null, null, [], '/p/nowhere')).toBe('/p/nowhere');
	});
});

describe('ensureRowVisible', () => {
	// Minimal DOM stubs: the helper only reads getBoundingClientRect() and
	// adjusts scrollTop, so no browser is needed.
	function fakeEl(top: number, bottom: number, scrollTop = 0): HTMLElement {
		return {
			getBoundingClientRect: () => ({ top, bottom }) as DOMRect,
			scrollTop
		} as unknown as HTMLElement;
	}

	it('scrolls up just enough to reveal a row above the viewport', () => {
		const scroller = fakeEl(100, 300, 200);
		ensureRowVisible(scroller, fakeEl(50, 70));
		// Pads the top edge: 200 - (100 + 4 - 50) = 146.
		expect(scroller.scrollTop).toBe(146);
	});

	it('scrolls down just enough to reveal a row below the viewport', () => {
		const scroller = fakeEl(100, 300, 200);
		ensureRowVisible(scroller, fakeEl(290, 320));
		// Pads the bottom edge: 200 + (320 - 300 + 4) = 224.
		expect(scroller.scrollTop).toBe(224);
	});

	it('leaves a fully visible row (and its ancestors) untouched', () => {
		const scroller = fakeEl(100, 300, 200);
		ensureRowVisible(scroller, fakeEl(150, 170));
		expect(scroller.scrollTop).toBe(200);
	});

	it('treats edge-hugging rows as visible', () => {
		const scroller = fakeEl(100, 300, 200);
		ensureRowVisible(scroller, fakeEl(104, 200));
		ensureRowVisible(scroller, fakeEl(200, 296));
		expect(scroller.scrollTop).toBe(200);
	});
});
