<script lang="ts">
	import type { ToolUseBlock, ConfigInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ConfigInput);

	const key = $derived(input.key || '');
	const value = $derived(input.value);
	const mode = $derived(value === undefined ? 'read' : 'set');
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Config:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{key}</code>
		{#if value !== undefined}
			<span class="text-xs text-slate-400 dark:text-slate-500">= {value}</span>
		{/if}
		<span class="text-xs px-1 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 shrink-0">{mode}</span>
	</div>
</div>
