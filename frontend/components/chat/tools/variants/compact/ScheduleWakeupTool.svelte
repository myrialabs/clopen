<script lang="ts">
	import type { ToolUseBlock, ScheduleWakeupInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ScheduleWakeupInput);

	const delaySeconds = $derived(input.delaySeconds || 0);
	const reason = $derived(input.reason || '');

	function formatDelay(seconds: number): string {
		if (seconds < 60) return `${seconds}s`;
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
		const hours = Math.floor(mins / 60);
		const remMins = mins % 60;
		return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
	}
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Wake in:</span>
		<span class="text-slate-800 dark:text-slate-200">{formatDelay(delaySeconds)}</span>
	</div>
	{#if reason}
		<div class="text-xs text-slate-400 dark:text-slate-500">{reason}</div>
	{/if}
</div>
