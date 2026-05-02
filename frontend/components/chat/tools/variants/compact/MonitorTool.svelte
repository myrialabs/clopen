<script lang="ts">
	import type { ToolUseBlock, MonitorInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as MonitorInput);

	const target = $derived(input.bashId || input.processId || input.source || 'stream');
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Monitor:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{target}</code>
		{#if input.until}
			<span class="text-xs text-slate-400 dark:text-slate-500">until: {input.until}</span>
		{/if}
	</div>
</div>
