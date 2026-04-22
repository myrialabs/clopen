<script lang="ts">
	import type { ToolUseBlock, LspInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as LspInput);
	const result = $derived(toolInput.result);

	const location = $derived([
		input.filePath,
		input.line != null ? `L${input.line}` : '',
		input.column != null ? `C${input.column}` : '',
	].filter(Boolean).join(':'));
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span>{input.operation || 'lsp'}</span>
		{#if input.symbol}
			<code class="font-mono">{input.symbol}</code>
		{/if}
		{#if location}
			<span class="font-mono opacity-60">{location}</span>
		{/if}
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
