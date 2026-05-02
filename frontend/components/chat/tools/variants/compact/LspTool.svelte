<script lang="ts">
	import type { ToolUseBlock, LspInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as LspInput);

	const location = $derived([
		input.filePath,
		input.line != null ? `L${input.line}` : '',
		input.column != null ? `C${input.column}` : '',
	].filter(Boolean).join(':'));
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">LSP {input.operation || 'lsp'}:</span>
		{#if input.symbol}
			<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{input.symbol}</code>
		{/if}
		{#if location}
			<span class="font-mono text-xs text-slate-400 dark:text-slate-500">{location}</span>
		{/if}
	</div>
</div>
