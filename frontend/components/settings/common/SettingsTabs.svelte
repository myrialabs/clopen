<script lang="ts" generics="T extends string">
	/**
	 * Tabs for a settings section with more than one part, so a section reads
	 * one part at a time instead of as one long scroll.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		tabs: Array<{ id: T; label: string }>;
		/** Bind to keep the choice outside (a deep link); otherwise the first tab. */
		active?: T;
		children: Snippet<[T]>;
	}

	let { tabs, active = $bindable(tabs[0].id), children }: Props = $props();
</script>

<div class="space-y-5">
	<div class="flex gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 w-fit max-w-full overflow-x-auto" role="tablist">
		{#each tabs as tab (tab.id)}
			<button
				type="button"
				role="tab"
				aria-selected={active === tab.id}
				class="px-3.5 py-1.5 rounded-md text-sm font-medium border-none cursor-pointer whitespace-nowrap {active === tab.id
					? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-sm'
					: 'bg-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}"
				onclick={() => (active = tab.id)}
			>{tab.label}</button>
		{/each}
	</div>
	{@render children(active)}
</div>
