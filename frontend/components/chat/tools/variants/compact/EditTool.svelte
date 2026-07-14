<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { countLineChanges } from '$shared/utils/diff-calculator';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');

	// Count only lines that actually changed (LCS-based), so identical context
	// lines inside the edited region aren't miscounted as +/-.
	const diff = $derived(countLineChanges(input.oldString || '', input.newString || ''));
</script>

<ToolRow icon="lucide:pencil" label="Edited" {filePath} {fileName} {diff} />

