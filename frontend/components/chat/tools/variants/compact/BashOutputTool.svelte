<script lang="ts">
	import type { ToolUseBlock, TaskOutputInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskOutputInput);
	const taskId = $derived(input.taskId);
	const meta = $derived(input.timeout ? `${input.timeout}ms` : '');
</script>

<ToolRow icon="lucide:square-terminal" label="Bash output" inlineCode={`task:${taskId}`} {meta} />
