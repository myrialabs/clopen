<script lang="ts">
	import type { ToolUseBlock, CronListInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronListInput);
	const result = $derived(toolInput.result);

	const filter = $derived(input.filter);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<InfoLine icon="lucide:calendar-clock" text={filter ? `List cron (filter: ${filter})` : 'List cron jobs'} />
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
