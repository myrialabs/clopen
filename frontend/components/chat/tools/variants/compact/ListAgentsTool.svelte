<script lang="ts">
	import type { ListAgentsInput, ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListAgentsInput);
</script>
<ToolRow icon="lucide:users" label="ListAgents" inlineCode={input.includeCompleted === false ? 'active' : 'all'} />
