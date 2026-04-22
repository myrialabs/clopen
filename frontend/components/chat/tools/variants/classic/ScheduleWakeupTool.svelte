<script lang="ts">
	import type { ToolUseBlock, ScheduleWakeupInput } from '$shared/types/unified';
	import { InfoLine } from './components';

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

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:alarm-clock" text="Wake up in {formatDelay(delaySeconds)}" />
		{#if reason}
			<InfoLine icon="lucide:info" text={reason} />
		{/if}
	</div>
</div>
