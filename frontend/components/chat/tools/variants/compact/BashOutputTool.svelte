<script lang="ts">
	import type { ToolUseBlock, TaskOutputInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TaskOutputInput);
	const taskId = $derived(input.taskId);
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">BashOutput:</span>
		<code class="font-mono text-slate-800 dark:text-slate-200">task:{taskId}</code>
		{#if input.timeout}
			<span class="text-xs text-slate-400 dark:text-slate-500">· {input.timeout}ms</span>
		{/if}
	</div>
</div>
