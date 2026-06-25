<script lang="ts">
	import type { ToolUseBlock, CronListInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronListInput);
	const detail = $derived(input.filter ? `filter: ${input.filter}` : 'all jobs');
</script>

<ToolRow icon="lucide:clock" label="Cron list" {detail} />
