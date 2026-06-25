<script lang="ts">
	import type { ToolUseBlock, CronDeleteInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as CronDeleteInput);
</script>

<ToolRow icon="lucide:clock" label="Cron delete" inlineCode={input.id || ''} />
