<script lang="ts">
	import type { ToolUseBlock, CronListInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronListInput);
	const result = $derived(toolInput.result);
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span>{input.filter ? `filter: ${input.filter}` : 'list cron jobs'}</span>
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
