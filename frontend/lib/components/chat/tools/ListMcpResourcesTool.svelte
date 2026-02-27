<script lang="ts">
	import type { ListMcpResourcesToolInput } from '$shared/types/messaging';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ListMcpResourcesToolInput } = $props();
	
	const server = toolInput.input.server;
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
{#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if}