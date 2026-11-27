<script lang="ts">
	import type { ToolUseBlock, BashInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as BashInput);

	const command = $derived(input.command || '');
	const description = $derived(input.description || '');
	const isBackground = $derived(input.runInBackground);
	const label = $derived(description || 'Ran');
	const chips = $derived(isBackground ? ['bg'] : []);
</script>

<!-- Output opens under the row, like every other tool's details -->
<ToolRow
	icon="lucide:square-terminal"
	{label}
	inlineCode={command}
	{chips}
/>
