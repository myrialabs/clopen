<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';

	const { toolInput: _toolInput }: { toolInput: ToolUseBlock } = $props();
</script>

<div class="text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">TaskList</span>
	</div>
</div>
