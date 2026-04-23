<script lang="ts">
	import type { ToolUseBlock, ListInput } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListInput);
	const result = $derived(toolInput.result);

	const path = $derived(input.path || '.');
	const ignore = $derived(input.ignore);
</script>

<div class="space-y-1">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span class="font-mono">{path}</span>
		{#if ignore && ignore.length > 0}
			<span class="opacity-50">· ignore: {ignore.join(', ')}</span>
		{/if}
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
