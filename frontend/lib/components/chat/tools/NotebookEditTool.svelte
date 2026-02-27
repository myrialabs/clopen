<script lang="ts">
	import type { NotebookEditToolInput } from '$shared/types/messaging';
	import { FileHeader, InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: NotebookEditToolInput } = $props();
	
	const notebookPath = toolInput.input.notebook_path;
	const fileName = notebookPath.split(/[/\\]/).pop() || notebookPath;
	const cellId = toolInput.input.cell_id;
	const cellType = toolInput.input.cell_type || 'code';
	const editMode = toolInput.input.edit_mode || 'replace';
	const newSource = toolInput.input.new_source;
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
{#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if}