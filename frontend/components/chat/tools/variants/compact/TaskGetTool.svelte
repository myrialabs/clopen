<script lang="ts">
	import type { ToolUseBlock, TaskGetInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskGetInput);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">TaskGet:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{input.taskId || 'unknown'}</code>
	</div>
</div>
