<script lang="ts">
	import type { ToolUseBlock, TaskOutputInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskOutputInput);
	const result = $derived(toolInput.result);

	const taskId = $derived(input.taskId);
	const block = $derived(input.block);
	const timeout = $derived(input.timeout);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<!-- Command Info -->
	<div class="flex gap-3">
		<InfoLine icon="lucide:terminal" text="Reading output from task: {taskId}" />
		{#if block}
			<InfoLine icon="lucide:clock" text="Blocking: {block}" />
		{/if}
		{#if timeout}
			<InfoLine icon="lucide:timer" text="Timeout: {timeout}ms" />
		{/if}
	</div>
</div>

<!-- Tool Result -->
{#if result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
