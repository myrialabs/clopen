/**
 * Fit Above Action
 *
 * For a list inside a menu that opens upward from the composer (`absolute
 * bottom-full`): caps the list's height to the room between the top of
 * whatever clips the menu — the dock, a scrolling panel, the window — and the
 * composer it opens from.
 *
 * The composer grows with its text, its edit banner and its attached files, so
 * a fixed `max-h-*` ran under the dock's header whenever it was tall. This
 * measures instead, and re-measures when the composer or the window changes
 * size, or when the caller says the content changed (`key`).
 */

export interface FitAboveOptions {
	/** The most the list may grow to, in px. */
	max: number;
	/** The least worth showing, in px — a menu squeezed below this reads as broken. */
	min?: number;
	/** What the menu spends outside the list: header, borders, air from the edge. */
	chrome: number;
	/** Any value that changes when the list's content does, to re-measure. */
	key?: unknown;
}

/** Air between the menu and the composer (the menu's own `mb-2`). */
const GAP_ABOVE_COMPOSER = 8;

export function fitAbove(node: HTMLElement, options: FitAboveOptions) {
	let opts = options;
	let frame = 0;

	function measure() {
		// The menu is positioned against the composer; that is the anchor.
		const menu = node.closest<HTMLElement>('[data-fit-above-menu]');
		const anchor = menu?.offsetParent as HTMLElement | null | undefined;
		if (!anchor) return;

		let limit = window.visualViewport?.offsetTop ?? 0;
		for (let el = anchor.parentElement; el; el = el.parentElement) {
			if (/(hidden|auto|scroll|clip)/.test(getComputedStyle(el).overflowY)) {
				limit = Math.max(limit, el.getBoundingClientRect().top);
			}
		}
		const room = anchor.getBoundingClientRect().top - limit - GAP_ABOVE_COMPOSER - opts.chrome;
		const height = Math.round(Math.min(opts.max, Math.max(opts.min ?? 96, room)));
		node.style.maxHeight = `${height}px`;
	}

	function schedule() {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(measure);
	}

	const anchor = node.closest<HTMLElement>('[data-fit-above-menu]')?.offsetParent as HTMLElement | null | undefined;
	const resize = new ResizeObserver(schedule);
	if (anchor) resize.observe(anchor);
	window.addEventListener('resize', schedule);
	window.visualViewport?.addEventListener('resize', schedule);
	measure();

	return {
		update(next: FitAboveOptions) {
			opts = next;
			schedule();
		},
		destroy() {
			cancelAnimationFrame(frame);
			resize.disconnect();
			window.removeEventListener('resize', schedule);
			window.visualViewport?.removeEventListener('resize', schedule);
		}
	};
}
