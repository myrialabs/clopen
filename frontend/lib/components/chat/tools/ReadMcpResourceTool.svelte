<script lang="ts">
	import type { ReadMcpResourceToolInput } from '$shared/types/messaging';
	import { InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ReadMcpResourceToolInput } = $props();
	
	const server = toolInput.input.server;
	const uri = toolInput.input.uri;
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<!-- Resource Info -->
	<div class="flex gap-3 mb-2">
		<InfoLine icon="lucide:file-text" text="Reading MCP resource" />
		<InfoLine icon="lucide:server" text="Server: {server}" />
	</div>
	
	<!-- URI -->
	<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
		<CodeBlock code={uri} type="neutral" label="Resource URI" />
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