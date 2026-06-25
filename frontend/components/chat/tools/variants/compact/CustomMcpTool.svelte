<script lang="ts">
	import { onMount } from 'svelte';
	import type { ToolUseBlock } from '$shared/types/unified';
	import { mcpServersStore } from '$frontend/stores/features/mcp-servers.svelte';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	function parseMcpToolName(fullName: string): { server: string; tool: string } {
		const withoutPrefix = fullName.replace('mcp__', '');
		const parts = withoutPrefix.split('__');
		return { server: parts[0] || 'unknown', tool: parts[1] || 'unknown' };
	}

	const parsed = $derived(parseMcpToolName(toolInput.name));
	const server = $derived(mcpServersStore.serverTitles[parsed.server] ?? parsed.server);
	const tool = $derived(parsed.tool);
	const label = $derived(`${server}`);

	onMount(() => { mcpServersStore.fetchInstalled(); });
</script>

<ToolRow icon="lucide:plug" {label} inlineCode={tool} />

