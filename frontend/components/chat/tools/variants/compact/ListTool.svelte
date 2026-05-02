<script lang="ts">
	import type { ToolUseBlock, ListInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListInput);

	const path = $derived(input.path || '.');
	const ignore = $derived(input.ignore);
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">List:</span>
		<span class="font-mono font-medium text-slate-800 dark:text-slate-200">{path}</span>
	</div>
	{#if ignore && ignore.length > 0}
		<div class="text-xs text-slate-400 dark:text-slate-500">ignore: {ignore.join(', ')}</div>
	{/if}
</div>
