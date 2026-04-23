<script lang="ts">
	import type { ToolUseBlock, PushNotificationInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as PushNotificationInput);
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Notify:</span>
		<span class="font-medium text-slate-800 dark:text-slate-200">{input.title || 'notification'}</span>
	</div>
	{#if input.message}
		<div class="text-xs text-slate-400 dark:text-slate-500">{input.message}</div>
	{/if}
</div>
