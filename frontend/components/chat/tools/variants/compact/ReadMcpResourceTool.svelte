<script lang="ts">
	import type { ToolUseBlock, ReadMcpResourceInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadMcpResourceInput);
</script>

<ToolRow icon="lucide:plug" label="MCP read" inlineCode={input.uri} meta={input.server || ''} />
