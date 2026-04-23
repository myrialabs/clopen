<script lang="ts">
	import type { ToolUseBlock, WebFetchInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WebFetchInput);
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Fetch:</span>
		<span class="font-mono text-slate-800 dark:text-slate-200">{input.url || ''}</span>
	</div>
</div>
