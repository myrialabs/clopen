<script lang="ts">
	import type { ToolUseBlock, ScheduleWakeupInput } from '$shared/types/unified';
	import { ToolRow } from './components';

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

	const detail = $derived(formatDelay(delaySeconds));
</script>

<ToolRow icon="lucide:alarm-clock" label="Wake in" {detail} meta={reason} />
