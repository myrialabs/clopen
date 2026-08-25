<script lang="ts">
	import type { SendMessageInput, ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as SendMessageInput);
	const target = $derived(input.agentId || input.taskId || input.recipient || 'unknown');
</script>
<ToolRow icon="lucide:send" label="SendMessage" inlineCode={target} />
