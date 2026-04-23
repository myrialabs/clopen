<script lang="ts">
	import type { ToolUseBlock, ReadMcpResourceInput } from '$shared/types/unified';
	import CodeBlock from './components/CodeBlock.svelte';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadMcpResourceInput);
	const result = $derived(toolInput.result);
</script>

<div class="space-y-1.5">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span>{input.server}</span>
		<span class="opacity-50">·</span>
		<code class="font-mono">{input.uri}</code>
	</div>
	{#if result?.content}
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	{/if}
</div>
