<script lang="ts">
	import type { ReadToolInput } from '$shared/types/messaging';
	import { FileHeader, InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ReadToolInput } = $props();
	
	const filePath = toolInput.input.file_path || '';
	const fileName = filePath.split(/[/\\]/).pop() || filePath || 'unknown';
	const hasLimit = toolInput.input.limit !== undefined;
	const hasOffset = toolInput.input.offset !== undefined;
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<FileHeader {filePath} {fileName} box={false} />

	<!-- Reading Options -->
	<div class="flex gap-2 border-t border-slate-200/60 dark:border-slate-700/60 pt-2 mt-2">
		{#if hasLimit || hasOffset}
			{#if hasOffset}
				<InfoLine icon="lucide:skip-forward" text="Starting from line {toolInput.input.offset}" />
			{/if}
			{#if hasLimit}
				<InfoLine icon="lucide:list" text="Reading {toolInput.input.limit} lines" />
			{/if}
		{:else}
			<InfoLine icon="lucide:file-scan" text="Reading entire file" />
		{/if}
	</div>
</div>

<!-- Tool Result -->
<!-- {#if toolInput.$result?.content}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if} -->