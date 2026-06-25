<script lang="ts">
	import type { ToolUseBlock, CronCreateInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronCreateInput);

	const name = $derived(input.name || 'untitled');
	const schedule = $derived(input.schedule || '');
</script>

<ToolRow icon="lucide:clock" label="Cron" detail={name} meta={schedule} />
