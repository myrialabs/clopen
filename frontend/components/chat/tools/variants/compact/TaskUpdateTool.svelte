<script lang="ts">
	import type { ToolUseBlock, TaskUpdateInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskUpdateInput);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">TaskUpdate:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{input.taskId || 'unknown'}</code>
		{#if input.status}
			<span class="text-xs text-slate-400 dark:text-slate-500">· {input.status}</span>
		{/if}
	</div>
</div>
