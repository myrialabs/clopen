<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { FileHeader, CodeBlock } from './components';
	import type { ToolUseBlock } from '$shared/types/unified';
	import { mcpServersStore } from '$frontend/stores/features/mcp-servers.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	onMount(() => { mcpServersStore.fetchInstalled(); });

	interface ParsedToolName {
		server: string;
		tool: string;
	}

	function parseMcpToolName(fullName: string): ParsedToolName {
		const withoutPrefix = fullName.replace('mcp__', '');
		const parts = withoutPrefix.split('__');
		return {
			server: parts[0] || 'unknown',
			tool: parts[1] || 'unknown'
		};
	}

	const parsedToolName = $derived(parseMcpToolName(toolInput.name));
	const server = $derived(parsedToolName.server);
	const tool = $derived(parsedToolName.tool);

	const serverDisplayName = $derived.by(() => {
		// Prefer the human title from the MCP store; fall back to title-casing the key.
		const title = mcpServersStore.serverTitles[server];
		if (title) return title;
		return server
			.split('-')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	});

	const toolDisplayName = $derived.by(() => {
		return tool
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	});

	const resultContent = $derived.by(() => {
		if (!result?.content) return null;
		const content = result.content;
		if (typeof content === 'string') return content;
		return String(content);
	});

	const isError = $derived.by(() => {
		if (!result?.content) return false;
		const content = result.content;
		if (typeof content === 'string') return content.toLowerCase().includes('error:');
		return false;
	});

	const formattedInput = $derived(JSON.stringify(toolInput.input, null, 2));
</script>

<div class="mb-2">
	<h3 class="text-slate-900 dark:text-slate-100 flex items-center gap-x-3 gap-y-1 flex-wrap">
		<div class="flex items-center gap-1.5">
			<Icon name="lucide:tool-case" class="w-4 h-4" />
			<span>{serverDisplayName}</span>
		</div>
		<div class="flex items-center gap-1.5">
			<Icon name="lucide:hammer" class="w-4 h-4" />
			<span>{toolDisplayName}</span>
		</div>
	</h3>
</div>

{#if toolInput.input && Object.keys(toolInput.input).length > 0}
	<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={formattedInput} type="neutral" label="Input" />
	</div>
{/if}

{#if resultContent}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={resultContent} type="neutral" label={isError ? 'Error' : 'Result'} />
	</div>
{:else if result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<p class="text-sm text-slate-500 dark:text-slate-400 italic">No result returned</p>
	</div>
{/if}
