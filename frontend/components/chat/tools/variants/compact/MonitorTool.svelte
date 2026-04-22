<script lang="ts">
	import type { ToolUseBlock, MonitorInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as MonitorInput);
	const result = $derived(toolInput.result);

	const target = $derived(input.bashId || input.processId || input.source || 'stream');
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<code class="font-mono">{target}</code>
		{#if input.until}
			<span class="opacity-50">until: {input.until}</span>
		{/if}
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
