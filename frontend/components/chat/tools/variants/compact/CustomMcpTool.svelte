<script lang="ts">
	import { onMount } from 'svelte';
	import type { ToolUseBlock } from '$shared/types/unified';
	import { mcpServersStore } from '$frontend/stores/features/mcp-servers.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	function parseMcpToolName(fullName: string): { server: string; tool: string } {
		const withoutPrefix = fullName.replace('mcp__', '');
		const parts = withoutPrefix.split('__');
		return { server: parts[0] || 'unknown', tool: parts[1] || 'unknown' };
	}

	const parsed = $derived(parseMcpToolName(toolInput.name));
	// Prefer the human title (e.g. "Browser Automation") over the raw key.
	const server = $derived(mcpServersStore.serverTitles[parsed.server] ?? parsed.server);
	const tool = $derived(parsed.tool);

	onMount(() => { mcpServersStore.fetchInstalled(); });
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">MCP:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{server}/{tool}</code>
	</div>
</div>
