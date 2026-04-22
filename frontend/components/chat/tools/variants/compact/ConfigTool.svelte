<script lang="ts">
	import type { ToolUseBlock, ConfigInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ConfigInput);
	const result = $derived(toolInput.result);

	const key = $derived(input.key || '');
	const value = $derived(input.value);
	const mode = $derived(value === undefined ? 'read' : 'set');
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span>{mode}</span>
		<code class="font-mono">{key}</code>
		{#if value !== undefined}
			<span class="opacity-50">= {value}</span>
		{/if}
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
