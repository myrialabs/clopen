<script lang="ts">
	import type { ToolUseBlock, ListInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListInput);
	const result = $derived(toolInput.result);

	const path = $derived(input.path || '.');
	const ignore = $derived(input.ignore);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:folder-tree" text="List {path}" />
		{#if ignore && ignore.length > 0}
			<InfoLine icon="lucide:eye-off" text="Ignore: {ignore.join(', ')}" />
		{/if}
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
