<script lang="ts">
	import type { ToolUseBlock, ToolSearchInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ToolSearchInput);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">ToolSearch:</span>
		<code class="font-mono font-medium text-slate-800 dark:text-slate-200">{input.query || ''}</code>
	</div>
</div>
