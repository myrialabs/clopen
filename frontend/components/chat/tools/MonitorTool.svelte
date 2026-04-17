<script lang="ts">
	import type { ToolUseBlock, MonitorInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as MonitorInput);
	const result = $derived(toolInput.result);

	const target = $derived(input.bashId || input.processId || input.source || 'stream');
	const until = $derived(input.until);
	const timeout = $derived(input.timeout);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:activity" text="Monitoring {target}" />
		{#if until}
			<InfoLine icon="lucide:target" text="Until: {until}" />
		{/if}
		{#if timeout != null}
			<InfoLine icon="lucide:timer" text="Timeout: {timeout}ms" />
		{/if}
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
