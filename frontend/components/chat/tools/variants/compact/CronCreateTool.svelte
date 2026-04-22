<script lang="ts">
	import type { ToolUseBlock, CronCreateInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronCreateInput);
	const result = $derived(toolInput.result);

	const name = $derived(input.name || 'untitled');
	const schedule = $derived(input.schedule || '');
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span class="font-medium">{name}</span>
		{#if schedule}
			<code class="font-mono opacity-70">{schedule}</code>
		{/if}
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
