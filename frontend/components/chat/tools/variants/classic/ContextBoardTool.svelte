<script lang="ts">
	import type { ContextBoardInput, ToolUseBlock } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ContextBoardInput);
	const item = $derived(input.name || input.src || 'board');
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2 space-y-1">
	<InfoLine icon="lucide:layout-dashboard" text="Context board: {input.command || 'view'} {item}" />
	{#if input.description}<InfoLine icon="lucide:align-left" text={input.description} />{/if}
	{#if input.context}<InfoLine icon="lucide:notebook-text" text={input.context} />{/if}
</div>
{#if toolInput.result?.content}<TextMessage content={toolInput.result.content} />{/if}
