<script lang="ts">
	import type { ToolUseBlock, KnownToolName } from '$shared/types/unified';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { debug } from '$shared/utils/logger';
	import { CustomMcpTool, UnknownTool, CustomMcpToolCompact, UnknownToolCompact } from '../tools';
	import { TOOL_COMPONENTS_CLASSIC, TOOL_COMPONENTS_COMPACT } from '../tools/registry';
	import ToolRenderError from '../tools/ToolRenderError.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	const isCompact = $derived(settings.chatAppearance === 'compact');

	const Component = $derived.by(() => {
		const name = toolInput.name;
		if (isCompact) {
			if (name.startsWith('mcp__')) return CustomMcpToolCompact;
			if (name.startsWith('Unknown:')) return UnknownToolCompact;
			return TOOL_COMPONENTS_COMPACT[name as KnownToolName] ?? UnknownToolCompact;
		}
		if (name.startsWith('mcp__')) return CustomMcpTool;
		if (name.startsWith('Unknown:')) return UnknownTool;
		return TOOL_COMPONENTS_CLASSIC[name as KnownToolName] ?? UnknownTool;
	});
</script>

<!--
	Every tool renderer is isolated. Tool inputs originate from the engine and are
	not guaranteed to match their declared schema, so a single bad block must not
	be able to tear down the surrounding chat — or the app.
-->
<svelte:boundary onerror={(error) => debug.error('chat', `Tool renderer failed for ${toolInput.name}:`, error)}>
	<Component {toolInput} />

	{#snippet failed(error, reset)}
		<ToolRenderError {toolInput} {error} {reset} />
	{/snippet}
</svelte:boundary>
