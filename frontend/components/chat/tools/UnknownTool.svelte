<script lang="ts">
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { ToolUseBlock } from '$shared/types/unified';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	const originalName = $derived(toolInput.name.startsWith('Unknown:')
		? toolInput.name.slice('Unknown:'.length)
		: toolInput.name);
	const inputString = $derived(JSON.stringify(toolInput.input, null, 2));
</script>

<div class="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
	<div class="flex items-start gap-3">
		<Icon name="lucide:circle-alert" class="text-red-500 w-5 h-5 mt-0.5 flex-none" />
		<div class="flex-1 min-w-0">
			<div class="font-medium text-red-700 dark:text-red-300 mb-1">
				Unhandled tool: {originalName}
			</div>
			<p class="text-xs text-red-600 dark:text-red-400 mb-2">
				No UI component is registered for this tool. Add it to <code class="font-mono">ToolInputMap</code> and <code class="font-mono">TOOL_COMPONENTS</code>.
			</p>
			<pre class="text-xs text-red-800 dark:text-red-200 bg-red-100/60 dark:bg-red-900/40 rounded p-2 overflow-auto font-mono">{inputString}</pre>
		</div>
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
