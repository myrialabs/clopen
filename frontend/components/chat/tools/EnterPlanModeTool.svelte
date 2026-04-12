<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex gap-3">
		<InfoLine icon="lucide:map" text="Entering plan mode" />
	</div>
</div>

<!-- Tool Result -->
{#if result}
	<div class="mt-4">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
