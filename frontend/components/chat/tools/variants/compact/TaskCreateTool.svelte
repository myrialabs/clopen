<script lang="ts">
	import type { ToolUseBlock, TaskCreateInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskCreateInput);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">TaskCreate:</span>
		<span class="text-slate-800 dark:text-slate-200">{input.subject || 'untitled'}</span>
	</div>
</div>
