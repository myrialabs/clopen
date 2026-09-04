<script lang="ts">
	import { portal } from '$frontend/utils/portal';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';

	export interface ProjectContextMenuItem {
		id: string;
		label: string;
		icon: IconName;
		danger?: boolean;
	}

	interface Props {
		items: ProjectContextMenuItem[];
		x: number;
		y: number;
		onSelect: (id: string) => void;
		onClose: () => void;
	}

	const { items, x, y, onSelect, onClose }: Props = $props();

	let menuElement = $state<HTMLDivElement>();
	let pos = $state({ top: 0, left: 0 });

	// Flip the menu back inside the viewport once its size is known
	$effect(() => {
		pos = { top: y, left: x };
		if (!menuElement) return;
		const rect = menuElement.getBoundingClientRect();
		const left = x + rect.width > window.innerWidth - 8 ? window.innerWidth - rect.width - 8 : x;
		const top = y + rect.height > window.innerHeight - 8 ? window.innerHeight - rect.height - 8 : y;
		pos = { top, left };
	});

	function handlePointerDown(event: MouseEvent) {
		if (menuElement && !menuElement.contains(event.target as Node)) onClose();
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			onClose();
		}
	}

	$effect(() => {
		// Defer listeners so the opening right-click does not close the menu
		const timer = setTimeout(() => {
			document.addEventListener('mousedown', handlePointerDown);
			document.addEventListener('contextmenu', handlePointerDown);
		}, 0);
		window.addEventListener('keydown', handleKeydown);
		window.addEventListener('resize', onClose);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('mousedown', handlePointerDown);
			document.removeEventListener('contextmenu', handlePointerDown);
			window.removeEventListener('keydown', handleKeydown);
			window.removeEventListener('resize', onClose);
		};
	});
</script>

<div
	bind:this={menuElement}
	use:portal
	class="fixed z-[10001] min-w-40 py-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl text-sm"
	style="top: {pos.top}px; left: {pos.left}px;"
	role="menu"
	tabindex="-1"
>
	{#each items as item (item.id)}
		<button
			type="button"
			class="flex items-center gap-2.5 w-full text-left px-3 py-1.5 bg-transparent border-none cursor-pointer transition-colors duration-150 {item.danger
				? 'text-red-600 dark:text-red-400 hover:bg-red-500/10'
				: 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}"
			role="menuitem"
			onclick={() => {
				onSelect(item.id);
				onClose();
			}}
		>
			<Icon name={item.icon} class="w-4 h-4 shrink-0" />
			<span>{item.label}</span>
		</button>
	{/each}
</div>
