<script lang="ts">
	import type { ToolUseBlock, TaskStopInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskStopInput);
</script>

<ToolRow icon="lucide:circle-stop" label="TaskStop" inlineCode={input.taskId || 'unknown'} />
