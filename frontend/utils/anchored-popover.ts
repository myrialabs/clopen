/**
 * Anchored Popover Action
 *
 * Positions a `position: fixed` dropdown against its trigger button and keeps
 * it on screen:
 * - opens above the trigger (the chat input sits at the bottom), flipping
 *   below only when there is clearly more room there;
 * - caps max-height to the space actually available on that side;
 * - clamps horizontally so it never runs off the right (or left) edge;
 * - follows window and `visualViewport` resizes (mobile keyboard, pinch zoom).
 *
 * Also owns the keyboard behaviour every picker needs: Escape closes, and
 * ArrowUp/ArrowDown/Home/End move focus between `[data-popover-item]`
 * elements inside the popover.
 *
 * The element should carry `position: fixed` (and its z-index) statically;
 * this action only writes top/bottom/left/max-height/transform-origin.
 */

export interface AnchoredPopoverOptions {
	/** The trigger the popover hangs off. */
	anchor: HTMLElement | null | undefined;
	/** Called on Escape. */
	onClose: () => void;
	/** Upper bound for max-height in px (the popover's natural design cap). */
	maxHeight?: number;
	/** Gap between trigger and popover in px. */
	gap?: number;
}

const VIEWPORT_MARGIN = 8;
/** Below this much room above the trigger, prefer opening downward if that side is roomier. */
const MIN_COMFORTABLE_HEIGHT = 200;

export function anchoredPopover(node: HTMLElement, options: AnchoredPopoverOptions) {
	let opts = options;
	let frame = 0;

	function position() {
		const anchor = opts.anchor;
		if (!anchor || !anchor.isConnected) return;

		const rect = anchor.getBoundingClientRect();
		const gap = opts.gap ?? 4;
		const cap = opts.maxHeight ?? 384;

		// The visible region in layout-viewport coordinates (what `fixed` uses).
		const vv = window.visualViewport;
		const viewTop = vv?.offsetTop ?? 0;
		const viewLeft = vv?.offsetLeft ?? 0;
		const viewHeight = vv?.height ?? window.innerHeight;
		const viewWidth = vv?.width ?? window.innerWidth;

		const spaceAbove = rect.top - viewTop - gap - VIEWPORT_MARGIN;
		const spaceBelow = viewTop + viewHeight - rect.bottom - gap - VIEWPORT_MARGIN;
		const openAbove = spaceAbove >= MIN_COMFORTABLE_HEIGHT || spaceAbove >= spaceBelow;

		if (openAbove) {
			node.style.top = 'auto';
			node.style.bottom = `${window.innerHeight - rect.top + gap}px`;
		} else {
			node.style.bottom = 'auto';
			node.style.top = `${rect.bottom + gap}px`;
		}
		node.style.maxHeight = `${Math.max(120, Math.min(cap, openAbove ? spaceAbove : spaceBelow))}px`;
		node.style.transformOrigin = openAbove ? 'bottom left' : 'top left';

		// offsetWidth ignores the open transition's scale transform.
		const width = node.offsetWidth;
		const minLeft = viewLeft + VIEWPORT_MARGIN;
		const maxLeft = viewLeft + viewWidth - VIEWPORT_MARGIN - width;
		node.style.left = `${Math.max(minLeft, Math.min(rect.left, maxLeft))}px`;
	}

	function schedule() {
		cancelAnimationFrame(frame);
		frame = requestAnimationFrame(position);
	}

	function items(): HTMLElement[] {
		return Array.from(node.querySelectorAll<HTMLElement>('[data-popover-item]:not([disabled])'));
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			// Capture phase + stop: Escape must close the picker, not reach the
			// chat input (where it would cancel a turn) or an enclosing modal.
			event.preventDefault();
			event.stopPropagation();
			opts.onClose();
			return;
		}

		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
		const active = document.activeElement as HTMLElement | null;
		const inside = !!active && (node.contains(active) || active === opts.anchor);
		if (!inside) return;
		const list = items();
		if (list.length === 0) return;

		event.preventDefault();
		const index = active ? list.indexOf(active) : -1;
		let next: number;
		if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = list.length - 1;
		else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % list.length;
		else next = index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length;
		list[next].focus();
		list[next].scrollIntoView({ block: 'nearest' });
	}

	position();

	const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
	resizeObserver?.observe(node);
	window.addEventListener('resize', schedule);
	window.visualViewport?.addEventListener('resize', schedule);
	window.visualViewport?.addEventListener('scroll', schedule);
	window.addEventListener('keydown', onKeydown, true);

	return {
		update(next: AnchoredPopoverOptions) {
			opts = next;
			position();
		},
		destroy() {
			cancelAnimationFrame(frame);
			resizeObserver?.disconnect();
			window.removeEventListener('resize', schedule);
			window.visualViewport?.removeEventListener('resize', schedule);
			window.visualViewport?.removeEventListener('scroll', schedule);
			window.removeEventListener('keydown', onKeydown, true);
		}
	};
}
