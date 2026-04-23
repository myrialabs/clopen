<script lang="ts">
	import type { ToolUseBlock, WebSearchInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WebSearchInput);

	const query = $derived(input.query || '');
	const domains = $derived(input.allowedDomains?.join(', ') || '');
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Search:</span>
		<span class="text-slate-800 dark:text-slate-200">{query}</span>
	</div>
	{#if domains}
		<div class="text-xs text-slate-400 dark:text-slate-500">{domains}</div>
	{/if}
</div>
