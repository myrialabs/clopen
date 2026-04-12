<script lang="ts">
	import type { ToolUseBlock, ListMcpResourcesInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListMcpResourcesInput);
	const result = $derived(toolInput.result);

	const server = $derived(input.server);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="flex gap-3">
		<InfoLine icon="lucide:server" text="Listing MCP resources" />
		{#if server}
			<InfoLine icon="lucide:filter" text="Server: {server}" />
		{:else}
			<InfoLine icon="lucide:globe" text="All servers" />
		{/if}
	</div>
</div>

<!-- Tool Result -->
{#if result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
