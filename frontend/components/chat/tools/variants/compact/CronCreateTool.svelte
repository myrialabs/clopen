<script lang="ts">
	import type { ToolUseBlock, CronCreateInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronCreateInput);

	const name = $derived(input.name || 'untitled');
	const schedule = $derived(input.schedule || '');
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Cron:</span>
		<span class="font-medium text-slate-800 dark:text-slate-200">{name}</span>
		{#if schedule}
			<code class="font-mono text-xs text-slate-400 dark:text-slate-500">{schedule}</code>
		{/if}
	</div>
</div>
