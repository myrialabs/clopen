<script lang="ts">
	import type { ContextBoardInput, ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ContextBoardInput);
	const item = $derived(input.name || input.src || 'board');
</script>
<ToolRow icon="lucide:layout-dashboard" label="ContextBoard" inlineCode="{input.command || 'view'} {item}" />
