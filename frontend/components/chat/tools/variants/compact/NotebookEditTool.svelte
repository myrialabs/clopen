<script lang="ts">
	import type { ToolUseBlock, NotebookEditInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as NotebookEditInput);

	const notebookPath = $derived(input.notebookPath);
	const fileName = $derived(notebookPath.split(/[/\\]/).pop() || notebookPath);
	const cellId = $derived(input.cellId);
	const cellType = $derived(input.cellType || 'code');
	const editMode = $derived(input.editMode || 'replace');

	const badges = $derived([
		{ text: editMode, color: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' },
		{ text: `${cellType} cell${cellId ? ` #${cellId}` : ''}`, color: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400' },
	]);
</script>

<FileHeader filePath={notebookPath} {fileName} operation="Edit" {badges} />
