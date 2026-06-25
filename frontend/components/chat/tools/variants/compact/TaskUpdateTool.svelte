<script lang="ts">
	import type { ToolUseBlock, TaskUpdateInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskUpdateInput);
	const chips = $derived(input.status ? [input.status] : []);
</script>

<ToolRow icon="lucide:list" label="TaskUpdate" inlineCode={input.taskId || 'unknown'} {chips} />
