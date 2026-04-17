<script lang="ts">
	import type { ToolUseBlock, LspInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as LspInput);
	const result = $derived(toolInput.result);

	const operation = $derived(input.operation || 'lsp');
	const filePath = $derived(input.filePath);
	const locationParts = $derived([
		input.line != null ? `line ${input.line}` : '',
		input.column != null ? `col ${input.column}` : '',
	].filter(Boolean).join(', '));
	const symbol = $derived(input.symbol);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:braces" text="LSP: {operation}" />
		{#if symbol}
			<InfoLine icon="lucide:at-sign" text={symbol} />
		{/if}
		{#if filePath}
			<InfoLine icon="lucide:file" text="{filePath}{locationParts ? ` (${locationParts})` : ''}" />
		{/if}
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
