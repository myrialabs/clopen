<script lang="ts">
	import type { ToolUseBlock, MonitorInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as MonitorInput);

	const target = $derived(input.bashId || input.processId || input.source || 'stream');
	const meta = $derived(input.until ? `until: ${input.until}` : '');
</script>

<ToolRow icon="lucide:activity" label="Monitor" inlineCode={target} {meta} />
