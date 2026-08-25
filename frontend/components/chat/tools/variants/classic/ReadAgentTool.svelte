<script lang="ts">
	import type { ReadAgentInput, ToolUseBlock } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadAgentInput);
	const mode = $derived(input.wait ? `wait${input.timeout ? ` up to ${input.timeout}s` : ''}` : 'current status');
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2 space-y-1">
	<InfoLine icon="lucide:bot" text="Read agent {input.agentId || 'unknown'}" />
	<InfoLine icon="lucide:clock" text={mode} />
	{#if input.sinceTurn !== undefined}<InfoLine icon="lucide:history" text="Since turn {input.sinceTurn}" />{/if}
</div>
{#if toolInput.result?.content}<TextMessage content={toolInput.result.content} />{/if}
