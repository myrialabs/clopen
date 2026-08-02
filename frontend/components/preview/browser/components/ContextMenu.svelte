<script lang="ts">
	/**
	 * Context menu for the preview canvas.
	 *
	 * Headless Chrome cannot draw its own menu, so the backend reports what was
	 * right-clicked and this renders the menu over the video. Two things make it
	 * read as the page's own menu rather than an app overlay:
	 *
	 * - It is drawn at the preview's scale. A menu at 1× floating over a page
	 *   shrunk to 0.4× looks pasted on; scaling it with the page keeps the
	 *   proportions a real browser would have.
	 * - It flips rather than slides. Chrome opens up-left near the bottom-right
	 *   corner so the click point stays visible; nudging a down-right menu back
	 *   inside the panel would cover exactly what was clicked.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { BrowserContextMenuInfo, BrowserContextMenuItem } from '$frontend/utils/native-ui';
	import type { IconName } from '$shared/types/ui/icons';

	let {
		menuInfo = null as BrowserContextMenuInfo | null,
		scale = 1,
		bounds = null as DOMRect | null,
		onSelectItem = (_itemId: string) => {},
		onClose = () => {}
	} = $props();

	let menuElement = $state<HTMLDivElement | undefined>();
	let highlightedItemId = $state<string | null>(null);
	let openSubmenuId = $state<string | null>(null);

	/** Natural (unscaled) size, measured once the menu is in the DOM. */
	let naturalWidth = $state(0);
	let naturalHeight = $state(0);

	/** Gap kept between the menu and the edge it flipped away from. */
	const EDGE_PADDING = 6;

	const selectableItems = $derived(
		(menuInfo?.items ?? []).filter(
			(item: BrowserContextMenuItem) => item.enabled && item.type !== 'separator'
		)
	);

	/**
	 * Place the menu at the click point, flipping whichever axis would overflow
	 * and clamping if it overflows even after flipping (a menu taller than the
	 * panel, which the body's own scroll then handles).
	 */
	function viewportRect(): DOMRect {
		return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
	}

	const position = $derived.by(() => {
		if (!menuInfo) return { left: 0, top: 0 };

		const area = bounds ?? viewportRect();
		const width = naturalWidth * scale;
		const height = naturalHeight * scale;

		let left = menuInfo.x;
		let top = menuInfo.y;

		if (width > 0 && left + width > area.right - EDGE_PADDING) {
			left = menuInfo.x - width;
		}
		if (height > 0 && top + height > area.bottom - EDGE_PADDING) {
			top = menuInfo.y - height;
		}

		left = Math.max(area.left + EDGE_PADDING, Math.min(left, area.right - width - EDGE_PADDING));
		top = Math.max(area.top + EDGE_PADDING, Math.min(top, area.bottom - height - EDGE_PADDING));

		return { left, top };
	});

	/** Keep the menu inside the panel even when the page has very long labels. */
	const maxHeight = $derived.by(() => {
		const area = bounds ?? viewportRect();
		return Math.max(120, area.height / Math.max(scale, 0.05) - EDGE_PADDING * 2);
	});

	function measure() {
		if (!menuElement) return;
		naturalWidth = menuElement.offsetWidth;
		naturalHeight = menuElement.offsetHeight;
	}

	function handleItemClick(item: BrowserContextMenuItem) {
		if (!item.enabled || item.type === 'separator') return;

		if (item.submenu?.length) {
			openSubmenuId = openSubmenuId === item.id ? null : item.id;
			return;
		}

		onSelectItem(item.id);
		onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (!menuInfo) return;

		const items = selectableItems;

		switch (event.key) {
			case 'ArrowDown': {
				event.preventDefault();
				const index = items.findIndex((item: BrowserContextMenuItem) => item.id === highlightedItemId);
				highlightedItemId = items[(index + 1) % items.length]?.id ?? null;
				break;
			}
			case 'ArrowUp': {
				event.preventDefault();
				const index = items.findIndex((item: BrowserContextMenuItem) => item.id === highlightedItemId);
				highlightedItemId = items[index <= 0 ? items.length - 1 : index - 1]?.id ?? null;
				break;
			}
			case 'Home':
				event.preventDefault();
				highlightedItemId = items[0]?.id ?? null;
				break;
			case 'End':
				event.preventDefault();
				highlightedItemId = items[items.length - 1]?.id ?? null;
				break;
			case 'Enter':
			case ' ': {
				event.preventDefault();
				const item = items.find((entry: BrowserContextMenuItem) => entry.id === highlightedItemId);
				if (item) handleItemClick(item);
				break;
			}
			case 'Escape':
				event.preventDefault();
				onClose();
				break;
		}
	}

	// Dismiss on anything that would move the menu away from what it points at.
	// `pointerdown` rather than `mousedown` so a tap outside closes it on touch
	// devices too — the old mouse-only listener left it stranded on mobile.
	$effect(() => {
		if (!menuInfo) return;

		openSubmenuId = null;
		highlightedItemId = null;

		queueMicrotask(() => {
			measure();
			menuElement?.focus();
		});

		const dismissOutside = (event: Event) => {
			if (menuElement && !menuElement.contains(event.target as Node)) onClose();
		};
		const dismiss = () => onClose();

		// Deferred by a frame so the pointerup of the right-click that opened the
		// menu cannot immediately close it again.
		const attach = requestAnimationFrame(() => {
			document.addEventListener('pointerdown', dismissOutside, true);
			window.addEventListener('wheel', dismiss, { passive: true });
			window.addEventListener('resize', dismiss);
			window.addEventListener('blur', dismiss);
		});

		return () => {
			cancelAnimationFrame(attach);
			document.removeEventListener('pointerdown', dismissOutside, true);
			window.removeEventListener('wheel', dismiss);
			window.removeEventListener('resize', dismiss);
			window.removeEventListener('blur', dismiss);
		};
	});
</script>

{#snippet menuItem(item: BrowserContextMenuItem)}
	<div
		class="group flex items-center gap-2.5 px-3 py-1.5 cursor-default select-none whitespace-nowrap rounded-[3px] mx-1
			{item.enabled
			? highlightedItemId === item.id
				? 'bg-violet-600 text-white'
				: 'text-slate-700 dark:text-slate-200'
			: 'text-slate-400 dark:text-slate-600 cursor-not-allowed'}"
		role="menuitem"
		tabindex={item.enabled ? 0 : -1}
		aria-disabled={!item.enabled}
		aria-haspopup={item.submenu?.length ? 'menu' : undefined}
		onclick={() => handleItemClick(item)}
		onkeydown={(event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				handleItemClick(item);
			}
		}}
		onmouseenter={() => {
			if (item.enabled) highlightedItemId = item.id;
			if (!item.submenu?.length) openSubmenuId = null;
		}}
	>
		<span class="flex w-4 shrink-0 items-center justify-center">
			{#if item.icon}
				<Icon name={item.icon as IconName} class="w-3.5 h-3.5" />
			{/if}
		</span>
		<span class="flex-1 text-[13px] leading-5">{item.label}</span>
		{#if item.submenu?.length}
			<Icon name="lucide:chevron-right" class="w-3.5 h-3.5 shrink-0 opacity-70" />
		{/if}
	</div>

	{#if item.submenu?.length && openSubmenuId === item.id}
		<div class="ml-6 border-l border-slate-200 dark:border-slate-700">
			{#each item.submenu as child (child.id)}
				{#if child.type === 'separator'}
					<div class="my-1 h-px bg-slate-200 dark:bg-slate-700" role="separator"></div>
				{:else}
					{@render menuItem(child)}
				{/if}
			{/each}
		</div>
	{/if}
{/snippet}

{#if menuInfo}
	<div
		bind:this={menuElement}
		class="context-menu fixed z-[999999] min-w-[13rem] py-1 rounded-lg overflow-y-auto
			bg-white/95 dark:bg-slate-800/95 backdrop-blur-sm
			border border-slate-200 dark:border-slate-700
			shadow-xl shadow-slate-900/20 dark:shadow-black/50
			outline-none origin-top-left"
		style="left: {position.left}px; top: {position.top}px; transform: scale({scale}); max-height: {maxHeight}px;"
		tabindex="-1"
		onkeydown={handleKeydown}
		role="menu"
		aria-label="Page context menu"
	>
		{#each menuInfo.items as item (item.id)}
			{#if item.type === 'separator'}
				<div class="my-1 h-px bg-slate-200 dark:bg-slate-700" role="separator"></div>
			{:else}
				{@render menuItem(item)}
			{/if}
		{/each}
	</div>
{/if}

<style>
	/* Opacity only — the element already carries a scale transform for the
	   preview fit, and animating transform here would fight it. */
	.context-menu {
		animation: context-menu-in 90ms ease-out;
	}

	@keyframes context-menu-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
