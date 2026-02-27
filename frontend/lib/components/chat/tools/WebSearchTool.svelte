<script lang="ts">
	import type { WebSearchToolInput } from '$shared/types/messaging';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: WebSearchToolInput } = $props();

	let showDetails = $state(false);

	// Format query for display
	function formatQuery(query: string): string {
		if (query.length > 60) {
			return query.substring(0, 57) + '...';
		}
		return query;
	}

	const formattedQuery = formatQuery(toolInput.input.query || '');
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
			{#if toolInput.input.allowed_domains?.length || toolInput.input.blocked_domains?.length}
				<button
					onclick={() => showDetails = !showDetails}
					class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
				>
					{showDetails ? 'Hide' : 'Show'} filters
				</button>
			{/if}
		</div>

		{#if showDetails && (toolInput.input.allowed_domains?.length || toolInput.input.blocked_domains?.length)}
			<div class="mt-2 p-3 bg-slate-50 dark:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700">
				{#if toolInput.input.allowed_domains?.length}
					<div class="mb-2">
						<p class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Allowed domains:</p>
						<div class="flex flex-wrap gap-1">
							{#each toolInput.input.allowed_domains as domain}
								<span class="inline-block px-2 py-1 text-xs bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
									{domain}
								</span>
							{/each}
						</div>
					</div>
				{/if}
				{#if toolInput.input.blocked_domains?.length}
					<div>
						<p class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Blocked domains:</p>
						<div class="flex flex-wrap gap-1">
							{#each toolInput.input.blocked_domains as domain}
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

<!-- Tool Result -->
<!-- {#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if} -->