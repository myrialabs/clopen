<script lang="ts">
	import type { ToolUseBlock, ReplInput } from '$shared/types/unified';
	import { CodeBlock, InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReplInput);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2">
	{#if input.description}<InfoLine icon="lucide:square-function" text={input.description} />{/if}
	<CodeBlock code={input.code || ''} type="neutral" label="JavaScript" />
</div>
{#if toolInput.result?.content}<TextMessage content={toolInput.result.content} />{/if}
