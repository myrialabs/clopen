<script lang="ts">
	import type { ToolUseBlock, ToolSearchInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ToolSearchInput);
	const result = $derived(toolInput.result);

	const query = $derived(input.query || '');
	const maxResults = $derived(input.maxResults);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:search" text="Loading tool schema: {query}" />
		{#if maxResults != null}
			<InfoLine icon="lucide:hash" text="Max results: {maxResults}" />
		{/if}
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
