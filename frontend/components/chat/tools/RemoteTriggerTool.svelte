<script lang="ts">
	import type { ToolUseBlock, RemoteTriggerInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as RemoteTriggerInput);
	const result = $derived(toolInput.result);

	const name = $derived(input.name || 'remote trigger');
	const payloadString = $derived(
		input.payload && Object.keys(input.payload).length > 0
			? JSON.stringify(input.payload, null, 2)
			: ''
	);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<InfoLine icon="lucide:radio-tower" text="Remote trigger: {name}" />
	{#if payloadString}
		<pre class="mt-2 text-xs text-slate-600 dark:text-slate-400 font-mono whitespace-pre-wrap">{payloadString}</pre>
	{/if}
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
