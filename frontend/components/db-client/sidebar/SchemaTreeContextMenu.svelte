<script lang="ts">
	import { scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import { tick } from 'svelte';
	import { portal } from '$frontend/utils/portal';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { ContextMenuItem } from './context-menu-types';

	interface Props {
		items: ContextMenuItem[];
		x: number;
		y: number;
		/** True when opened from a ⋮ button: right-align to the anchor point (Files behavior). */
		alignRight?: boolean;
		onSelect: (id: string) => void;
		onClose: () => void;
	}

	const { items, x, y, alignRight = false, onSelect, onClose }: Props = $props();

	let menuElement = $state<HTMLDivElement | undefined>(undefined);
	let pos = $state({ top: y, left: x });
	// Hidden until measured once: prevents the one-frame flash at (x, y)
	// before clamping flips the menu back inside the viewport.
	let placed = $state(false);

	const GUTTER = 8;

	function viewportSize(): { vw: number; vh: number } {
		// visualViewport tracks the on-screen pinch/toolbar area on Android/iOS
		// Safari/Chrome; fall back to layout viewport on desktop.
		const vv = window.visualViewport;
		return {
			vw: vv?.width ?? window.innerWidth,
			vh: vv?.height ?? window.innerHeight
		};
	}

	function clampPosition(): void {
		if (!menuElement) return;
		const rect = menuElement.getBoundingClientRect();
		const { vw, vh } = viewportSize();
		// Anchor point: right-click point, or just right of the ⋮ button
		// (left edge = button right + 4px). The menu opens to the RIGHT of
		// the button by default and only flips left when room runs out.
		let nx = alignRight ? x - rect.width : x;
		let ny = y;
		// No room below → flip above the anchor with the same 4px gap.
		if (ny + rect.height > vh - GUTTER) {
			ny = Math.max(GUTTER, y - rect.height - 4);
		}
		// No room on the right → open to the left of the anchor point.
		if (nx + rect.width > vw - GUTTER) {
			nx = Math.max(GUTTER, x - rect.width);
		}
		if (nx < GUTTER) nx = GUTTER;
		if (ny < GUTTER) ny = GUTTER;
		pos = { top: ny, left: nx };
	}

	$effect(() => {
		// Re-run when anchor point changes; measure after paint.
		void x;
		void y;
		void alignRight;
		placed = false;
		pos = { top: y, left: alignRight ? x - 176 : x };
		let cancelled = false;
		void tick().then(() => {
			requestAnimationFrame(() => {
				if (cancelled) return;
				clampPosition();
				placed = true;
			});
		});
		return () => {
			cancelled = true;
		};
	});

	function handlePointerDown(e: Event): void {
		if (menuElement && !menuElement.contains(e.target as Node)) onClose();
	}

	function handleKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	function handleResize(): void {
		// Re-clamp on rotation / toolbar show-hide so the menu never ends up off-screen.
		clampPosition();
	}

	function handleScroll(e: Event): void {
		// Scroll di dalam menu (menu bisa di-scroll, max-h-80) jangan menutupnya;
		// hanya scroll di luar menu (mis. daftar tabel di sidebar) yang menutup.
		if (menuElement && menuElement.contains(e.target as Node)) return;
		onClose();
	}

	$effect(() => {
		// Defer so the opening tap/click does not immediately close the menu.
		// pointerdown covers mouse + touch + pen uniformly (touch taps do not
		// reliably produce compatibility mousedown on mobile browsers).
		const t = setTimeout(() => {
			document.addEventListener('pointerdown', handlePointerDown);
			document.addEventListener('contextmenu', handlePointerDown);
		}, 0);
		window.addEventListener('keydown', handleKey);
		window.addEventListener('resize', handleResize);
		window.addEventListener('orientationchange', handleResize);
		window.visualViewport?.addEventListener('resize', handleResize);
		// Close on outside scroll (capture: inner containers too) — a fixed menu
		// does not travel with its list, so it would otherwise detach.
		// Scrolling inside the menu itself never closes it.
		window.addEventListener('scroll', handleScroll, true);
		return () => {
			clearTimeout(t);
			document.removeEventListener('pointerdown', handlePointerDown);
			document.removeEventListener('contextmenu', handlePointerDown);
			window.removeEventListener('keydown', handleKey);
			window.removeEventListener('resize', handleResize);
			window.removeEventListener('orientationchange', handleResize);
			window.visualViewport?.removeEventListener('resize', handleResize);
			window.removeEventListener('scroll', handleScroll, true);
		};
	});
</script>

<div
	bind:this={menuElement}
	use:portal
	class="fixed z-[10001] w-44 max-w-[calc(100vw-16px)] max-h-80 py-1 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg overflow-y-auto overscroll-contain touch-manipulation"
	style="top: {pos.top}px; left: {pos.left}px; visibility: {placed ? 'visible' : 'hidden'}; max-height: min(20rem, calc(100dvh - 16px));"
	transition:scale={{ duration: 150, easing: cubicOut, start: 0.95, opacity: 0 }}
	role="menu"
	tabindex="-1"
>
	{#each items as item (item.id)}
		{#if item.separator}
			<div class="border-t border-slate-200 dark:border-slate-700 my-1" role="separator"></div>
		{:else}
			<button
				type="button"
				class="w-full px-3 py-1.5 text-xs text-left flex items-center gap-2 bg-transparent border-none cursor-pointer touch-manipulation select-none transition-colors {item.danger
					? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
					: 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700'}"
				role="menuitem"
				onclick={() => {
					onSelect(item.id);
					onClose();
				}}
			>
				{#if item.icon}
					<Icon name={item.icon} class="w-3 h-3 shrink-0" />
				{/if}
				<span class="flex-1">{item.label}</span>
			</button>
		{/if}
	{/each}
</div>
