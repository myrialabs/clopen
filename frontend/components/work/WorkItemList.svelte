<script lang="ts">
	/**
	 * The list of work items.
	 *
	 * Every row carries "Start work" rather than hiding it behind the detail
	 * view: the whole point of this surface is going from a list of things to do
	 * to an agent doing one of them, and making that two clicks deep would be
	 * burying the feature inside its own panel.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import type { WorkItem } from '$shared/types/work';
	import { relativeTime } from '$frontend/utils/relative-time';
	import type { IconName } from '$shared/types/ui/icons';

	const items = $derived(workStore.items);
	const selectedId = $derived(workStore.selectedId);
	const startingId = $derived(workStore.startingId);

	/** Colour and glyph carry the state category, never the provider's wording. */
	function stateStyle(item: WorkItem): { icon: IconName; class: string } {
		switch (item.stateCategory) {
			case 'merged':
				return { icon: 'lucide:git-merge', class: 'text-violet-500 dark:text-violet-400' };
			case 'closed':
				return {
					icon: item.kind === 'pull-request' ? 'lucide:git-pull-request-closed' : 'lucide:circle-check',
					class: 'text-slate-500 dark:text-slate-400'
				};
			case 'draft':
				return { icon: 'lucide:git-pull-request-draft', class: 'text-slate-500 dark:text-slate-400' };
			default:
				return {
					icon: item.kind === 'pull-request' ? 'lucide:git-pull-request' : 'lucide:circle-dot',
					class: 'text-green-600 dark:text-green-400'
				};
		}
	}

</script>

{#if items.length === 0}
	<div class="flex flex-col items-center justify-center gap-2 h-full px-6 text-center">
		<Icon name="lucide:inbox" class="w-8 h-8 text-slate-400 dark:text-slate-600" />
		<p class="text-sm text-slate-600 dark:text-slate-400 m-0">Nothing here</p>
		<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
			Try a different filter, or clear the search.
		</p>
	</div>
{:else}
	<ul class="flex flex-col list-none m-0 p-0">
		{#each items as item (item.id)}
			{@const style = stateStyle(item)}
			<li>
				<div
					class="flex items-start gap-2 px-3 py-2 border-b border-slate-100 dark:border-slate-800/70 cursor-pointer transition-colors duration-150
						{item.id === selectedId
						? 'bg-violet-500/10'
						: 'hover:bg-slate-50 dark:hover:bg-slate-800/40'}"
					role="button"
					tabindex="0"
					onclick={() => workStore.select(item)}
					onkeydown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							workStore.select(item);
						}
					}}
				>
					<Icon name={style.icon} class="w-4 h-4 mt-0.5 shrink-0 {style.class}" />

					<div class="flex flex-col min-w-0 flex-1 gap-1">
						<span class="text-sm text-slate-900 dark:text-slate-100 leading-snug">
							{item.title}
						</span>
						<span class="flex items-center gap-1.5 flex-wrap text-xs text-slate-500 dark:text-slate-500">
							<span class="font-mono">#{item.identifier}</span>
							<span>·</span>
							<span title={new Date(item.updatedAt).toLocaleString()}>{relativeTime(item.updatedAt)}</span>
							{#if item.assignees.length > 0}
								<span>·</span>
								<span class="truncate">{item.assignees.join(', ')}</span>
							{/if}
							{#if item.commentCount > 0}
								<span class="flex items-center gap-0.5">
									<Icon name="lucide:message-square" class="w-3 h-3" />
									{item.commentCount}
								</span>
							{/if}
						</span>
						{#if item.labels.length > 0}
							<span class="flex items-center gap-1 flex-wrap">
								{#each item.labels.slice(0, 3) as label (label)}
									<span class="px-1.5 py-0.5 text-[0.65rem] rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
										{label}
									</span>
								{/each}
							</span>
						{/if}
					</div>

					<!--
						Always visible, never hover-revealed. A touch screen has no
						hover, so a control that only appears on hover is a control a
						phone user cannot reach at all.
					-->
					<button
						type="button"
						class="flex items-center justify-center gap-1 h-7 shrink-0 px-1.5 text-[0.7rem] font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60"
						disabled={startingId !== null}
						onclick={(event) => {
							event.stopPropagation();
							workStore.startWork(item);
						}}
						title="Create a worktree and start a session on this item"
					>
						{#if startingId === item.id}
							<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin" />
							Starting…
						{:else}
							<Icon name="lucide:play" class="w-3 h-3" />
							Start
						{/if}
					</button>
				</div>
			</li>
		{/each}
	</ul>
{/if}
