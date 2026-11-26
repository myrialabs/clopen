<script lang="ts">
	/**
	 * The right-hand side of the hosting view: the open issues and pull
	 * requests as tabs, the same way the other Git views keep open diffs as
	 * tabs. Reading three pull requests side by side used to mean opening and
	 * closing a modal three times.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import WorkItemDetailPane from '$frontend/components/work/WorkItemDetailPane.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import type { WorkItem } from '$shared/types/work';

	interface Props {
		/** Present in a one-column panel, where the list and the item take turns. */
		onBack?: () => void;
	}

	const { onBack }: Props = $props();

	const items = $derived(workStore.openItems);

	function iconOf(item: WorkItem): IconName {
		if (item.kind === 'issue') return item.stateCategory === 'closed' ? 'lucide:circle-check' : 'lucide:circle-dot';
		if (item.stateCategory === 'merged') return 'lucide:git-merge';
		if (item.stateCategory === 'closed') return 'lucide:git-pull-request-closed';
		return item.stateCategory === 'draft' ? 'lucide:git-pull-request-draft' : 'lucide:git-pull-request';
	}
</script>

<div class="h-full flex flex-col min-h-0">
	{#if items.length > 0 || onBack}
		<div class="flex items-stretch border-b border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/50 flex-shrink-0">
			{#if onBack}
				<button
					type="button"
					class="flex items-center justify-center px-2.5 border-r border-slate-200/50 dark:border-slate-700/50 bg-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 cursor-pointer"
					onclick={onBack}
					title="Back to the list"
				>
					<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
				</button>
			{/if}
			<div class="flex items-center overflow-x-auto flex-1 min-w-0">
				{#each items as item (`${item.kind}-${item.id}`)}
					{@const active = item.id === workStore.selectedId}
					<div
						class="flex items-center gap-1.5 pl-3 pr-2 py-2 text-xs border-r border-slate-200/50 dark:border-slate-700/50 whitespace-nowrap flex-shrink-0 cursor-pointer {active
							? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100'
							: 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
						role="tab"
						tabindex="0"
						aria-selected={active}
						onclick={() => void workStore.select(item)}
						onkeydown={(event) => event.key === 'Enter' && void workStore.select(item)}
						title={item.title}
					>
						<Icon name={iconOf(item)} class="w-3.5 h-3.5 flex-shrink-0" />
						<span class="font-mono">#{item.identifier}</span>
						<span class="truncate max-w-32">{item.title}</span>
						<button
							type="button"
							class="flex p-0.5 hover:bg-slate-200 dark:hover:bg-slate-700 rounded flex-shrink-0 opacity-60 hover:opacity-100 bg-transparent border-none cursor-pointer"
							onclick={(event) => { event.stopPropagation(); workStore.closeItem(item.id); }}
							title="Close tab"
						>
							<Icon name="lucide:x" class="w-3 h-3" />
						</button>
					</div>
				{/each}
			</div>
			{#if items.length > 1}
				<button
					type="button"
					class="flex items-center justify-center px-2.5 border-l border-slate-200/50 dark:border-slate-700/50 text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 bg-transparent cursor-pointer flex-shrink-0"
					onclick={() => workStore.closeAllItems()}
					title="Close all tabs"
				>
					<Icon name="lucide:x" class="w-3.5 h-3.5" />
				</button>
			{/if}
		</div>
	{/if}
	<div class="flex-1 min-h-0 bg-white/40 dark:bg-slate-900/40">
		<WorkItemDetailPane />
	</div>
</div>
