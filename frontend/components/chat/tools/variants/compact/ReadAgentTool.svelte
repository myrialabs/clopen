<script lang="ts">
	import type { ReadAgentInput, ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadAgentInput);
</script>
<ToolRow icon="lucide:bot" label="ReadAgent" inlineCode={input.agentId || 'unknown'} meta={input.wait ? 'wait' : ''} />
