<script lang="ts">
	import type { ToolUseBlock, KnownToolName } from '$shared/types/unified';
	import { CustomMcpTool, UnknownTool } from '../tools';
	import { TOOL_COMPONENTS } from '../tools/registry';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	const Component = $derived.by(() => {
		const name = toolInput.name;
		if (name.startsWith('mcp__')) return CustomMcpTool;
		if (name.startsWith('Unknown:')) return UnknownTool;
		return TOOL_COMPONENTS[name as KnownToolName] ?? UnknownTool;
	});
</script>

<Component {toolInput} />
