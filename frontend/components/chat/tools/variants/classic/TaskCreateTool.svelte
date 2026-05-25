<script lang="ts">
	import type { ToolUseBlock, TaskCreateInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskCreateInput);
	const result = $derived(toolInput.result);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex gap-3">
		<InfoLine icon="lucide:list-plus" text="Create task: {input.subject || 'untitled'}" />
	</div>
	{#if input.description}
		<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">{input.description}</p>
	{/if}
</div>

{#if result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
