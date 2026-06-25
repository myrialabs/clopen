<script lang="ts">
	import type { ToolUseBlock, TaskGetInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskGetInput);
</script>

<ToolRow icon="lucide:list" label="TaskGet" inlineCode={input.taskId || 'unknown'} />
