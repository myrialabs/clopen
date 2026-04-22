<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	const originalName = $derived(toolInput.name.startsWith('Unknown:')
		? toolInput.name.slice('Unknown:'.length)
		: toolInput.name);
	const inputString = $derived(JSON.stringify(toolInput.input, null, 2));
</script>

<div class="p-4 bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 rounded-lg">
	<div class="flex-1 min-w-0">
		<div class="font-medium text-slate-700 dark:text-slate-300 mb-1">
			Unhandled tool: {originalName}
		</div>
		<p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
			No UI component is registered for this tool. Add it to <code class="font-mono">ToolInputMap</code> and <code class="font-mono">TOOL_COMPONENTS</code>.
		</p>
		<pre class="text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 rounded p-2 overflow-auto font-mono">{inputString}</pre>
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
