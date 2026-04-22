<script lang="ts">
	import type { ToolUseBlock, GlobInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GlobInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || 'current directory');
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Glob:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{pattern}</code>
	</div>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-xs text-slate-400 dark:text-slate-500">{searchPath}</span>
	</div>
</div>
