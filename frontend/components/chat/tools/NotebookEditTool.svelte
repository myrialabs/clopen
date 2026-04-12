<script lang="ts">
	import type { ToolUseBlock, NotebookEditInput } from '$shared/types/unified';
	import { FileHeader, InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as NotebookEditInput);
	const result = $derived(toolInput.result);

	const notebookPath = $derived(input.notebookPath);
	const fileName = $derived(notebookPath.split(/[/\\]/).pop() || notebookPath);
	const cellId = $derived(input.cellId);
	const cellType = $derived(input.cellType || 'code');
	const editMode = $derived(input.editMode || 'replace');
	const newSource = $derived(input.newSource);
</script>

<FileHeader filePath={notebookPath} fileName={fileName} />

<!-- Edit Details -->
<div class="flex gap-2 border-t border-slate-200/60 dark:border-slate-700/60 pt-2 mt-3">
	<InfoLine icon="lucide:notebook" text="{editMode} {cellType} cell" />
	{#if cellId}
		<InfoLine icon="lucide:hash" text="Cell ID: {cellId}" />
	{/if}
</div>

<!-- New Source -->
<CodeBlock code={newSource} type={editMode === 'insert' ? 'add' : editMode === 'delete' ? 'remove' : 'neutral'} label="{editMode === 'insert' ? 'Adding' : editMode === 'delete' ? 'Deleting' : 'Updating'} cell content" />

<!-- Tool Result -->
{#if result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
