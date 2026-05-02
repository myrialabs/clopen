<script lang="ts">
	import type { ToolUseBlock, ExitWorktreeInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ExitWorktreeInput);

	const keep = $derived(input.keep === true);
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Worktree exit:</span>
		<span class="text-slate-800 dark:text-slate-200">{keep ? 'keep changes' : 'discard changes'}</span>
	</div>
</div>
