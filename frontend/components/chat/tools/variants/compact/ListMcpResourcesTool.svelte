<script lang="ts">
	import type { ToolUseBlock, ListMcpResourcesInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListMcpResourcesInput);
</script>

<ToolRow icon="lucide:plug" label="MCP list" detail={input.server || 'all servers'} />
