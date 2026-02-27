<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { ToolInput } from '$shared/types/messaging';
	import {
		BashTool, BashOutputTool, EditTool, ExitPlanModeTool,
		GlobTool, GrepTool, KillShellTool, ListMcpResourcesTool,
		NotebookEditTool,
		ReadTool, ReadMcpResourceTool, TaskTool, TodoWriteTool,
		WebFetchTool, WebSearchTool, WriteTool, CustomMcpTool
	} from '../tools';

	const { toolInput }: { toolInput: ToolInput } = $props();

	/**
	 * Check if tool is a custom MCP tool
	 * MCP tool names follow format: mcp__server-name__tool-name
	 */
	function isCustomMcpTool(toolName: string): boolean {
		return toolName.startsWith('mcp__');
	}
</script>

<!-- Route to specific tool display components -->
{#if isCustomMcpTool(toolInput.name)}
	<!-- Custom MCP Tools -->
	<CustomMcpTool {toolInput} />
{:else if toolInput.name === 'TodoWrite'}
	<TodoWriteTool {toolInput} />
{:else if toolInput.name === 'Bash'}
	<BashTool {toolInput} />
{:else if toolInput.name === 'TaskOutput'}
	<BashOutputTool {toolInput} />
{:else if toolInput.name === 'Edit'}
	<EditTool {toolInput} />
{:else if toolInput.name === 'ExitPlanMode'}
	<ExitPlanModeTool {toolInput} />
{:else if toolInput.name === 'Glob'}
	<GlobTool {toolInput} />
{:else if toolInput.name === 'Grep'}
	<GrepTool {toolInput} />
{:else if toolInput.name === 'KillShell'}
	<KillShellTool {toolInput} />
{:else if toolInput.name === 'ListMcpResources'}
	<ListMcpResourcesTool {toolInput} />
{:else if toolInput.name === 'NotebookEdit'}
	<NotebookEditTool {toolInput} />
{:else if toolInput.name === 'Read'}
	<ReadTool {toolInput} />
{:else if toolInput.name === 'ReadMcpResource'}
	<ReadMcpResourceTool {toolInput} />
{:else if toolInput.name === 'Task'}
	<TaskTool {toolInput} />
{:else if toolInput.name === 'WebFetch'}
	<WebFetchTool {toolInput} />
{:else if toolInput.name === 'WebSearch'}
	<WebSearchTool {toolInput} />
{:else if toolInput.name === 'Write'}
	<WriteTool {toolInput} />
{:else}
	<!-- Generic fallback for unknown tools -->
	<div class="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg p-4 mb-4">
		<div class="flex items-center gap-2 mb-2">
			<Icon name="lucide:wrench" class="text-green-600 dark:text-green-400 w-5 h-5" />
			<span class="font-medium text-green-700 dark:text-green-300">Using {(toolInput as any).name}</span>
		</div>
		<div class="bg-white dark:bg-slate-800 rounded border border-slate-200 dark:border-slate-700 p-3">
			<pre class="text-xs text-slate-600 dark:text-slate-400 whitespace-pre-wrap font-mono">{JSON.stringify((toolInput as any).input, null, 2)}</pre>
		</div>
	</div>
{/if}