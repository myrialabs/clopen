<script lang="ts">
	/**
	 * One popover surface for every menu in this feature.
	 *
	 * It exists because the same three mistakes were being repeated per menu:
	 *
	 *  - APPEARING WITHOUT A TRANSITION. A panel that pops into place reads as a
	 *    glitch rather than as a response to the click.
	 *  - A FIXED SIDE. `right-0` is correct next to the right edge of a modal and
	 *    wrong everywhere else; a menu anchored on the left of a wide screen ran
	 *    off the window. The side is a measurement, not a constant.
	 *  - BEING CUT OFF BY ITS OWN CARD. An absolutely positioned menu is clipped
	 *    by every `overflow-hidden` ancestor, so the comment menu ended under the
	 *    card below it — nothing was painting over it, the card it lives in was
	 *    scissoring it.
	 *
	 * So the surface is `position: fixed` and placed from a MEASUREMENT of the
	 * trigger: fixed escapes ancestor clipping, and the numbers come from where
	 * the trigger actually is rather than from where the component assumed it
	 * would be. It stays a DOM child of the trigger's wrapper — moving it to the
	 * body would put it outside the `use:clickOutside` node that owns it, and
	 * every click inside the menu would then close the menu.
	 */
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';

	interface Props {
		/** Side to prefer when there is room for either. */
		prefer?: 'start' | 'end';
		/** Width utility class — the menu sizes itself, the caller says how wide. */
		width?: string;
		class?: string;
		children: import('svelte').Snippet;
	}

	const { prefer = 'end', width = 'w-48', class: extra = '', children }: Props = $props();

	/** Space to leave between the menu and the window edge. */
	const GUTTER = 8;
	/** Space between the menu and the control that opened it. */
	const OFFSET = 4;

	interface Placement {
		left: number;
		top: number;
		maxHeight: number;
		origin: string;
	}

	let element = $state<HTMLElement | null>(null);
	let placement = $state<Placement | null>(null);

	/**
	 * Measure the trigger, then decide.
	 *
	 * The menu's own size comes from its layout properties rather than from a
	 * rect: the open transition scales the element, and a rect taken
	 * mid-transition reports the scaled box, which would place the menu against
	 * a size it is about to stop having.
	 */
	function place() {
		const node = element;
		const anchor = node?.parentElement;
		if (!node || !anchor) return;

		const trigger = anchor.getBoundingClientRect();
		const width = node.offsetWidth;
		// `scrollHeight` too: a placement that capped the menu would otherwise be
		// re-measured at its capped size and could never grow back when the room
		// returns.
		const height = Math.max(node.offsetHeight, node.scrollHeight);
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		// Horizontal: start the preferred way round, then flip only if that side
		// overflows and the other one does not.
		let left = prefer === 'end' ? trigger.right - width : trigger.left;
		if (left + width > viewportWidth - GUTTER && trigger.right - width >= GUTTER) {
			left = trigger.right - width;
		} else if (left < GUTTER && trigger.left + width <= viewportWidth - GUTTER) {
			left = trigger.left;
		}
		// A menu wider than the room on either side is clamped rather than left
		// hanging off the window.
		left = Math.min(Math.max(left, GUTTER), Math.max(GUTTER, viewportWidth - width - GUTTER));

		// Vertical: below unless below does not fit and above does.
		const below = trigger.bottom + OFFSET;
		const roomBelow = viewportHeight - below - GUTTER;
		const roomAbove = trigger.top - OFFSET - GUTTER;
		const goAbove = height > roomBelow && roomAbove > roomBelow;

		const top = goAbove ? Math.max(GUTTER, trigger.top - OFFSET - height) : below;
		const maxHeight = Math.max(120, goAbove ? roomAbove : roomBelow);

		placement = {
			left,
			top,
			maxHeight,
			origin: `${prefer === 'end' && left > trigger.left ? 'right' : 'left'} ${goAbove ? 'bottom' : 'top'}`
		};
	}

	$effect(() => {
		place();

		// A fixed menu does not travel with a scrolling list, so it is replaced
		// on every scroll — capture, because the scroll that matters is usually
		// an inner container's rather than the window's.
		const onMove = () => place();
		window.addEventListener('scroll', onMove, true);
		window.addEventListener('resize', onMove);
		return () => {
			window.removeEventListener('scroll', onMove, true);
			window.removeEventListener('resize', onMove);
		};
	});
</script>

<div
	bind:this={element}
	class="fixed z-[200] {width} bg-white dark:bg-slate-800 border border-violet-500/20 rounded-lg shadow-2xl shadow-slate-900/20 dark:shadow-black/40 overflow-y-auto overflow-x-hidden {extra}"
	style:left="{placement?.left ?? 0}px"
	style:top="{placement?.top ?? 0}px"
	style:max-height={placement ? `${placement.maxHeight}px` : undefined}
	style:transform-origin={placement?.origin ?? 'left top'}
	style:visibility={placement ? 'visible' : 'hidden'}
	transition:scale={{ duration: 130, easing: cubicOut, start: 0.96, opacity: 0 }}
>
	{@render children()}
</div>
