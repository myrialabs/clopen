<script lang="ts">
	import type { ToolUseBlock, ConfigInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ConfigInput);

	const key = $derived(input.key || '');
	const value = $derived(input.value);
	const mode = $derived(value === undefined ? 'read' : 'set');
	const meta = $derived(value !== undefined ? `= ${value}` : '');
</script>

<ToolRow icon="lucide:settings-2" label="Config" inlineCode={key} {meta} chips={[mode]} />
