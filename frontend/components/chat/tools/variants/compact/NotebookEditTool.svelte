<script lang="ts">
	import type { ToolUseBlock, NotebookEditInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as NotebookEditInput);

	const notebookPath = $derived(input.notebookPath);
	const fileName = $derived(notebookPath.split(/[/\\]/).pop() || notebookPath);
	const cellId = $derived(input.cellId);
	const cellType = $derived(input.cellType || 'code');
	const editMode = $derived(input.editMode || 'replace');
	const meta = $derived(`${cellType} cell${cellId ? ` #${cellId}` : ''}`);
</script>

<ToolRow icon="lucide:notebook-pen" label="Edited notebook" filePath={notebookPath} {fileName} {meta} />

