<script lang="ts">
	import type { ToolUseBlock, WebSearchInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WebSearchInput);

	let showDetails = $state(false);

	// Format query for display
	function formatQuery(query: string): string {
		if (query.length > 60) {
			return query.substring(0, 57) + '...';
		}
		return query;
	}

	const formattedQuery = $derived(formatQuery(input.query || ''));
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100">
			Web Search
		</h3>
		<p class="text-sm text-slate-700 dark:text-slate-300 mt-1">
			{formattedQuery}
		</p>
	</div>

	<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
		<div class="flex gap-3 items-center">
			<InfoLine icon="lucide:globe" text="Searching the web" />
			{#if input.allowedDomains?.length || input.blockedDomains?.length}
				<button
					onclick={() => showDetails = !showDetails}
					class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
				>
					{showDetails ? 'Hide' : 'Show'} filters
				</button>
			{/if}
		</div>

		{#if showDetails && (input.allowedDomains?.length || input.blockedDomains?.length)}
			<div class="mt-2 p-3 bg-slate-50 dark:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700">
				{#if input.allowedDomains?.length}
					<div class="mb-2">
						<p class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Allowed domains:</p>
						<div class="flex flex-wrap gap-1">
							{#each input.allowedDomains as domain}
								<span class="inline-block px-2 py-1 text-xs bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
									{domain}
								</span>
							{/each}
						</div>
					</div>
				{/if}
				{#if input.blockedDomains?.length}
					<div>
						<p class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Blocked domains:</p>
						<div class="flex flex-wrap gap-1">
							{#each input.blockedDomains as domain}
								<span class="inline-block px-2 py-1 text-xs bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 rounded">
									{domain}
								</span>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>
