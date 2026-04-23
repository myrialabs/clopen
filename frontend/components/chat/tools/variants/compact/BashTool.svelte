<script lang="ts">
	import type { ToolUseBlock, BashInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as BashInput);

	const command = $derived(input.command || '');
	const description = $derived(input.description);
	const isBackground = $derived(input.runInBackground);
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Bash:</span>
		<span class="font-mono text-slate-800 dark:text-slate-200">$ {command}</span>
		{#if isBackground}
			<span class="text-xs px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0">bg</span>
		{/if}
	</div>
	{#if description}
		<div class="text-xs text-slate-400 dark:text-slate-500">{description}</div>
	{/if}
</div>
