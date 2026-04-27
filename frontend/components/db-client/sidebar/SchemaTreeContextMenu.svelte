<script lang="ts">
	import { portal } from '$frontend/utils/portal';
	import type { ContextMenuItem } from './context-menu-types';

	interface Props {
		items: ContextMenuItem[];
		x: number;
		y: number;
		onSelect: (id: string) => void;
		onClose: () => void;
	}

	const { items, x, y, onSelect, onClose }: Props = $props();

	let menuElement = $state<HTMLDivElement | undefined>(undefined);
	let pos = $state({ top: 0, left: 0 });

	$effect(() => {
		pos = { top: y, left: x };
		if (!menuElement) return;
		const rect = menuElement.getBoundingClientRect();
		const ww = window.innerWidth;
		const wh = window.innerHeight;
		let nx = x;
		let ny = y;
		if (nx + rect.width > ww - 8) nx = ww - rect.width - 8;
		if (ny + rect.height > wh - 8) ny = wh - rect.height - 8;
		pos = { top: ny, left: nx };
	});

	function handleClickOutside(e: MouseEvent): void {
		if (menuElement && !menuElement.contains(e.target as Node)) onClose();
	}

	function handleKey(e: KeyboardEvent): void {
		if (e.key === 'Escape') {
			e.preventDefault();
			onClose();
		}
	}

	$effect(() => {
		const t = setTimeout(() => {
			document.addEventListener('mousedown', handleClickOutside);
			document.addEventListener('contextmenu', handleClickOutside);
		}, 0);
		window.addEventListener('keydown', handleKey);
		return () => {
			clearTimeout(t);
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('contextmenu', handleClickOutside);
			window.removeEventListener('keydown', handleKey);
		};
	});
</script>

<div
	bind:this={menuElement}
	use:portal
	class="fixed z-[10001] min-w-[180px] py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl text-sm"
	style="top: {pos.top}px; left: {pos.left}px;"
	role="menu"
>
	{#each items as item (item.id)}
		{#if item.separator}
			<div class="my-1 h-px bg-slate-200 dark:bg-slate-700" role="separator"></div>
		{:else}
			<button
				type="button"
				class="block w-full text-left px-3 py-1.5 hover:bg-slate-100 dark:hover:bg-slate-800 {item.danger
					? 'text-red-600 dark:text-red-400'
					: 'text-slate-700 dark:text-slate-200'}"
				role="menuitem"
				onclick={() => {
					onSelect(item.id);
					onClose();
				}}
			>
				{item.label}
			</button>
		{/if}
	{/each}
</div>
