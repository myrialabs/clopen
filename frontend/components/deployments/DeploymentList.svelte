<script lang="ts">
	/**
	 * The deployment list.
	 *
	 * One row is one build. Nothing here is hover-revealed: a touch screen has
	 * no hover and the control simply does not exist there — the same lesson the
	 * Issues list learned after its first QA pass. Row actions live in the detail
	 * pane instead, where there is room to explain what they do.
	 *
	 * The "Live" marker is the only thing a reader really scans for, so it is a
	 * badge on the row rather than a column: a production build that is ready but
	 * superseded looks identical to the one serving traffic without it.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Button from '$frontend/components/common/display/Button.svelte';
	import StateBadge from './StateBadge.svelte';
	import { shortRelativeTime } from '$frontend/utils/relative-time';
	import type { Deployment } from '$shared/types/deployments';

	interface Props {
		items: Deployment[];
		selectedId: string | null;
		isLoading: boolean;
		hasMore: boolean;
		isLoadingMore: boolean;
		onSelect: (id: string) => void;
		/** Empty because a filter hid everything, rather than because there is nothing. */
		isFilteredEmpty: boolean;
		/** This remote project has genuinely never produced a build. */
		isNeverDeployed: boolean;
		canDeploy: boolean;
		onDeploy: () => void;
		onClearFilters: () => void;
	}

	const {
		items,
		selectedId,
		isLoading,
		hasMore,
		isLoadingMore,
		onSelect,
		isFilteredEmpty,
		isNeverDeployed,
		canDeploy,
		onDeploy,
		onClearFilters
	}: Props = $props();
</script>

{#if isLoading && items.length === 0}
	<div class="flex items-center justify-center flex-1 py-10">
		<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
	</div>
{:else if items.length === 0}
	<!--
		Three different empties, three different answers. Telling someone
		"nothing matches this filter" when no filter is set and the project has
		simply never been deployed sends them looking for a filter that is not
		there — and hides the one button they actually needed.
	-->
	<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 py-10 text-center">
		<Icon name="lucide:rocket" class="w-8 h-8 text-slate-300 dark:text-slate-700" />

		{#if isNeverDeployed}
			<p class="text-sm text-slate-700 dark:text-slate-300 m-0">Never deployed yet</p>
			<p class="text-xs text-slate-500 dark:text-slate-500 max-w-xs m-0">
				This deploy target has no builds at all. Start one and it appears here — or check the
				target above is the right one.
			</p>
			{#if canDeploy}
				<Button size="sm" class="mt-1" onclick={onDeploy}>Deploy now</Button>
			{/if}
		{:else if isFilteredEmpty}
			<p class="text-sm text-slate-700 dark:text-slate-300 m-0">Nothing matches this filter</p>
			<p class="text-xs text-slate-500 dark:text-slate-500 max-w-xs m-0">
				There are builds on this target, just none in this environment or on this branch.
			</p>
			<button
				type="button"
				class="mt-1 text-xs text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer underline underline-offset-2"
				onclick={onClearFilters}
			>
				Clear the filters
			</button>
		{:else}
			<p class="text-sm text-slate-700 dark:text-slate-300 m-0">No deployments to show</p>
			<p class="text-xs text-slate-500 dark:text-slate-500 max-w-xs m-0">
				A build appears here as soon as one starts.
			</p>
			{#if canDeploy}
				<Button size="sm" class="mt-1" onclick={onDeploy}>Deploy now</Button>
			{/if}
		{/if}
	</div>
{:else}
	<ul class="flex flex-col gap-px list-none m-0 p-0">
		{#each items as item (item.id)}
			<li class="contents">
				<button
					type="button"
					class="flex flex-col gap-1.5 w-full px-3 py-2.5 bg-transparent border-none border-l-2 text-left cursor-pointer transition-colors duration-150
						{item.id === selectedId
						? 'bg-violet-500/10 border-l-violet-500'
						: 'border-l-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
					onclick={() => onSelect(item.id)}
				>
					<div class="flex items-center gap-2 w-full min-w-0">
						<StateBadge state={item.state} detail={item.stateDetail} compact />
						<span class="flex-1 min-w-0 text-xs font-medium text-slate-900 dark:text-slate-100 truncate">
							{item.commitMessage?.split('\n')[0] || item.branch || item.url || item.id}
						</span>
						{#if item.isCurrent}
							<span
								class="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
								title="Serving production traffic right now"
							>
								Live
							</span>
						{/if}
					</div>

					<div class="flex items-center gap-2 w-full min-w-0 text-[11px] text-slate-500 dark:text-slate-500">
						<span class="shrink-0 capitalize">{item.environment}</span>
						{#if item.branch}
							<span class="shrink-0">·</span>
							<span class="inline-flex items-center gap-1 min-w-0">
								<Icon name="lucide:git-branch" class="w-3 h-3 shrink-0" />
								<span class="truncate">{item.branch}</span>
							</span>
						{/if}
						{#if item.commitSha}
							<span class="shrink-0">·</span>
							<span class="shrink-0 font-mono">{item.commitSha.slice(0, 7)}</span>
						{/if}
						<span class="shrink-0 ml-auto">{shortRelativeTime(item.createdAt)}</span>
					</div>
				</button>
			</li>
		{/each}
	</ul>

	{#if isLoadingMore}
		<div class="flex items-center justify-center py-3">
			<Icon name="lucide:loader-circle" class="w-4 h-4 text-slate-400 animate-spin" />
		</div>
	{:else if !hasMore && items.length > 0}
		<p class="px-3 py-3 m-0 text-[11px] text-slate-400 dark:text-slate-600 text-center">
			That is every deployment matching this filter.
		</p>
	{/if}
{/if}
