/**
 * Explorer tree keyboard-navigation math.
 *
 * Guards the ArrowUp/ArrowDown/Home/End contract:
 * - navigation moves one row at a time in display order and clamps at the
 *   first/last visible row, never wrapping;
 * - unrelated keys hold position, so nothing else in the tree is hijacked;
 * - the selection mode follows the click modifiers (plain collapses, Ctrl
 *   moves the focus cursor only, Shift ranges from the anchor);
 * - the Shift anchor always resolves to something that keeps the
 *   clicked/focused row inside the resulting block.
 */

import { describe, it, expect } from 'bun:test';

import {
	computeNavIndex,
	ensureRowVisible,
	navSelectionMode,
	resolveShiftAnchor,
	sliceRange
} from './explorer-nav';

describe('computeNavIndex', () => {
	it('moves one row with ArrowUp/ArrowDown', () => {
		expect(computeNavIndex(5, 20, 'ArrowDown')).toBe(6);
		expect(computeNavIndex(5, 20, 'ArrowUp')).toBe(4);
	});

	it('clamps at the first and last row instead of wrapping', () => {
		expect(computeNavIndex(0, 20, 'ArrowUp')).toBe(0);
		expect(computeNavIndex(19, 20, 'ArrowDown')).toBe(19);
	});

	it('jumps to the ends with Home/End', () => {
		expect(computeNavIndex(7, 20, 'Home')).toBe(0);
		expect(computeNavIndex(7, 20, 'End')).toBe(19);
	});

	it('holds position for unrelated keys', () => {
		// PageUp/PageDown are intentionally not navigation keys — the native
		// page-scroll of the tree's own container handles them.
		expect(computeNavIndex(5, 20, 'PageDown')).toBe(5);
		expect(computeNavIndex(5, 20, 'PageUp')).toBe(5);
		expect(computeNavIndex(5, 20, 'Enter')).toBe(5);
		expect(computeNavIndex(5, 20, 'c')).toBe(5);
	});

	it('reports -1 for an empty list', () => {
		expect(computeNavIndex(0, 0, 'ArrowDown')).toBe(-1);
	});

	it('clamps an out-of-range start index before moving', () => {
		expect(computeNavIndex(99, 20, 'ArrowDown')).toBe(19);
		expect(computeNavIndex(-4, 20, 'ArrowUp')).toBe(0);
	});

	it('lands on the only row of a single-item list', () => {
		expect(computeNavIndex(0, 1, 'ArrowDown')).toBe(0);
		expect(computeNavIndex(0, 1, 'End')).toBe(0);
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
	it('collapses on plain arrows', () => {
		expect(navSelectionMode({ shift: false, ctrl: false })).toBe('collapse');
	});

	it('moves focus only on Ctrl/Cmd+navigation, so a multi-selection survives', () => {
		expect(navSelectionMode({ shift: false, ctrl: true })).toBe('focus-only');
	});

	it('ranges on Shift+navigation (with or without Ctrl)', () => {
		expect(navSelectionMode({ shift: true, ctrl: false })).toBe('range');
		expect(navSelectionMode({ shift: true, ctrl: true })).toBe('range');
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

	it('skips selected paths that are no longer visible', () => {
		expect(
			resolveShiftAnchor(visible, null, null, ['/p/gone', '/p/also-gone'], visible[0])
		).toBe('/p/composer.json');
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
