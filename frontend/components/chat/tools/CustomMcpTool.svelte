<script lang="ts">
	import { FileHeader, CodeBlock } from './components';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import type { ToolUseBlock } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	/**
	 * Parse MCP tool name
	 * Format: mcp__server-name__tool-name
	 */
	interface ParsedToolName {
		server: string;
		tool: string;
	}

	function parseMcpToolName(fullName: string): ParsedToolName {
		// Remove "mcp__" prefix
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

	// Format server name for display (e.g., "weather-service" -> "Weather Service")
	const serverDisplayName = $derived.by(() => {
		return server
			.split('-')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	});

	// Format tool name for display (e.g., "get_temperature" -> "Get Temperature")
	const toolDisplayName = $derived.by(() => {
		return tool
			.split('_')
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	});

	// Extract result content
	const resultContent = $derived.by(() => {
		if (!result?.content) return null;

		const content = result.content;

		// If content is already a string, return it
		if (typeof content === 'string') {
			return content;
		}

		// Fallback: convert to string
		return String(content);
	});

	// Check if result is an error
	const isError = $derived.by(() => {
		if (!result?.content) return false;

		const content = result.content;

		// Check for error markers in string content
		if (typeof content === 'string') {
			return content.toLowerCase().includes('error:');
		}

		return false;
	});

	// Format input for display
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

<!-- Tool Input -->
{#if toolInput.input && Object.keys(toolInput.input).length > 0}
	<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={formattedInput} type="neutral" label="Input" />
	</div>
{/if}

<!-- Tool Result -->
{#if resultContent}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={resultContent} type="neutral" label={isError ? 'Error' : 'Result'} />
	</div>
{:else if result}
	<!-- Empty result -->
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<p class="text-sm text-slate-500 dark:text-slate-400 italic">No result returned</p>
	</div>
{/if}
