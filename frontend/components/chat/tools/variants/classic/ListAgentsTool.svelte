<script lang="ts">
	import type { ListAgentsInput, ToolUseBlock } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListAgentsInput);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2">
	<InfoLine icon="lucide:users" text={input.includeCompleted === false ? 'List active agents' : 'List all agents'} />
</div>
{#if toolInput.result?.content}<TextMessage content={toolInput.result.content} />{/if}
