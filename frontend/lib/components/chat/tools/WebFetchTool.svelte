<script lang="ts">
	import type { WebFetchToolInput } from '$shared/types/messaging';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: WebFetchToolInput } = $props();
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100">
			Web Fetch
		</h3>
		<p class="text-sm text-slate-700 dark:text-slate-300 mt-1">
			Fetching: <span class="font-mono text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">{toolInput.input.url || ''}</span>
		</p>
	</div>

	<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
		<p class="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Processing prompt:</p>
		<p class="text-xs text-slate-600 dark:text-slate-400 font-mono leading-relaxed">
			{toolInput.input.prompt || ''}
		</p>
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