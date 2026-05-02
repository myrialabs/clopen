<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	const originalName = $derived(toolInput.name.startsWith('Unknown:')
		? toolInput.name.slice('Unknown:'.length)
		: toolInput.name);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-red-500 dark:text-red-400 shrink-0">Unhandled:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{originalName}</code>
	</div>
</div>
