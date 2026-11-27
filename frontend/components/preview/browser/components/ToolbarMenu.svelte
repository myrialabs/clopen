<script lang="ts" module>
	import type { IconName } from '$shared/types/ui/icons';

	export interface ToolbarMenuItem {
		id: string;
		label: string;
		icon: IconName;
		enabled?: boolean;
	}
</script>

<script lang="ts">
	/**
	 * An icon button in the preview toolbar that opens a short menu — the
	 * `@` mention menu and the overflow menu share it, so they look and close
	 * the same way. Labels only, kept compact like the rest of the toolbar.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';

	let {
		icon,
		title,
		heading = '',
		items = [] as ToolbarMenuItem[],
		disabled = false,
		onSelect = (_id: string) => {}
	}: {
		icon: IconName;
		title: string;
		heading?: string;
		items?: ToolbarMenuItem[];
		disabled?: boolean;
		onSelect?: (id: string) => void;
	} = $props();

	let isOpen = $state(false);
	let rootElement = $state<HTMLDivElement | undefined>();

	function run(id: string) {
		isOpen = false;
		onSelect(id);
	}

	function handleWindowPointerDown(event: PointerEvent) {
		if (isOpen && rootElement && !rootElement.contains(event.target as Node)) isOpen = false;
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (isOpen && event.key === 'Escape') isOpen = false;
	}
</script>

<svelte:window onpointerdown={handleWindowPointerDown} onkeydown={handleWindowKeydown} />

<div bind:this={rootElement} class="relative flex items-center">
	<button
		type="button"
		onclick={() => (isOpen = !isOpen)}
		{disabled}
		class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent dark:hover:bg-slate-800 dark:hover:text-slate-100 {isOpen
			? 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100'
			: ''}"
		{title}
		aria-label={title}
		aria-haspopup="menu"
		aria-expanded={isOpen}
	>
		<Icon name={icon} class="h-4 w-4" />
	</button>

	{#if isOpen}
		<div
			class="absolute right-0 top-full z-50 mt-1.5 w-56 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
			role="menu"
		>
			{#if heading}
				<div class="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-slate-400">{heading}</div>
			{/if}
			{#each items as item (item.id)}
				<button
					type="button"
					role="menuitem"
					onclick={() => run(item.id)}
					disabled={item.enabled === false}
					class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800"
				>
					<Icon name={item.icon} class="h-4 w-4 shrink-0 text-slate-400" />
					<span class="min-w-0 truncate">{item.label}</span>
				</button>
			{/each}
		</div>
	{/if}
</div>
