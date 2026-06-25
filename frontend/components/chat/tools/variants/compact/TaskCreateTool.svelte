<script lang="ts">
	import type { ToolUseBlock, TaskCreateInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskCreateInput);
</script>

<ToolRow icon="lucide:list-plus" label="TaskCreate" detail={input.subject || 'untitled'} />
