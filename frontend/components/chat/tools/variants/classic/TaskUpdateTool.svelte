<script lang="ts">
	import type { ToolUseBlock, TaskUpdateInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskUpdateInput);
	const result = $derived(toolInput.result);

	const label = $derived(
		input.status
			? `Update task ${input.taskId}: ${input.status}`
			: `Update task: ${input.taskId}`
	);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex gap-3">
		<InfoLine icon="lucide:square-pen" text={label} />
	</div>
	{#if input.subject}
		<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">{input.subject}</p>
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
