<script lang="ts">
	import type { BashOutputToolInput } from '$shared/types/messaging';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: BashOutputToolInput } = $props();

	const taskId = toolInput.input.task_id;
	const block = toolInput.input.block;
	const timeout = toolInput.input.timeout;
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
{#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if}
