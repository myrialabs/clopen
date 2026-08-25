<script lang="ts">
	import type { SendInboxInput, ToolUseBlock } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as SendInboxInput);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2 space-y-1">
	<InfoLine icon="lucide:inbox" text={input.summary || 'Send context to inbox'} />
	{#if input.content}<InfoLine icon="lucide:message-square" text={input.content} />{/if}
</div>
{#if toolInput.result?.content}<TextMessage content={toolInput.result.content} />{/if}
