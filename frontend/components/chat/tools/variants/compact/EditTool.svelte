<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { countLineChanges } from '$shared/utils/diff-calculator';
	import { ToolRow } from './components';
	import { addAiChange } from '$frontend/utils/ai-changes';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');

	// Count only lines that actually changed (LCS-based), so identical context
	// lines inside the edited region aren't miscounted as +/-.
	const diff = $derived(countLineChanges(input.oldString || '', input.newString || ''));

	const hasResult = $derived(!!toolInput.result && !toolInput.result.isError);
	const oldString = $derived(input.oldString || '');
	const newString = $derived(input.newString || '');
	let editIndex = $state<number | null>(null);

	$effect(() => {
		if (hasResult && filePath) {
			editIndex = addAiChange(filePath, oldString, newString, toolInput.id);
		}
	});
</script>

<ToolRow icon="lucide:pencil" label="Edited" {filePath} {fileName} {diff} {editIndex} />

