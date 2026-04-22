<script lang="ts">
	import type { ToolUseBlock, KnownToolName } from '$shared/types/unified';
	import { settings } from '$frontend/stores/features/settings.svelte';
	import { CustomMcpTool, UnknownTool, CustomMcpToolCompact, UnknownToolCompact } from '../tools';
	import { TOOL_COMPONENTS_CLASSIC, TOOL_COMPONENTS_COMPACT } from '../tools/registry';

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

<Component {toolInput} />
