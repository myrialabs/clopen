<script lang="ts">
	import type { ToolUseBlock, CronCreateInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronCreateInput);
	const result = $derived(toolInput.result);

	const name = $derived(input.name || 'untitled');
	const schedule = $derived(input.schedule || '');
	const prompt = $derived(input.prompt || '');
	const description = $derived(input.description);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:calendar-plus" text="Create cron: {name}" />
		{#if schedule}
			<InfoLine icon="lucide:clock" text={schedule} />
		{/if}
		{#if description}
			<InfoLine icon="lucide:info" text={description} />
		{/if}
	</div>
	{#if prompt}
		<pre class="mt-2 text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap">{prompt}</pre>
	{/if}
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
