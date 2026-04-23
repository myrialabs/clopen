<script lang="ts">
	import type { ToolUseBlock, GrepInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GrepInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || 'current directory');
	const modifiers = $derived([
		input.glob ? `glob:${input.glob}` : '',
		input.type ? `type:${input.type}` : '',
		input.caseInsensitive ? '-i' : '',
		input.multiline ? 'multiline' : '',
	].filter(Boolean).join(' '));
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Grep:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{pattern}</code>
	</div>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-xs text-slate-400 dark:text-slate-500">{searchPath}</span>
		{#if modifiers}
			<span class="text-xs font-mono text-slate-400 dark:text-slate-500">{modifiers}</span>
		{/if}
	</div>
</div>
