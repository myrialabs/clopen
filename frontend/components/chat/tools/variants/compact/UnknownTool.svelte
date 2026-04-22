<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	const originalName = $derived(toolInput.name.startsWith('Unknown:')
		? toolInput.name.slice('Unknown:'.length)
		: toolInput.name);
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-red-500 dark:text-red-400">
		<span>unhandled: <code class="font-mono">{originalName}</code></span>
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
