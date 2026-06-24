<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');

	const additions = $derived(input.newString ? input.newString.split('\n').length : 0);
	const deletions = $derived(input.oldString ? input.oldString.split('\n').length : 0);
	const diff = $derived({ additions, deletions });
</script>

<ToolRow icon="lucide:pencil" label="Edited" {filePath} {fileName} {diff} />

