<script lang="ts">
	import type { ToolUseBlock, ReadInput } from '$shared/types/unified';
	import { FileHeader, InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const hasLimit = $derived(input.limit !== undefined);
	const hasOffset = $derived(input.offset !== undefined);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<FileHeader {filePath} {fileName} box={false} />

	<!-- Reading Options -->
	<div class="flex gap-2 border-t border-slate-200/60 dark:border-slate-700/60 pt-2 mt-2">
		{#if hasLimit || hasOffset}
			{#if hasOffset}
				<InfoLine icon="lucide:skip-forward" text="Starting from line {input.offset}" />
			{/if}
			{#if hasLimit}
				<InfoLine icon="lucide:list" text="Reading {input.limit} lines" />
			{/if}
		{:else}
			<InfoLine icon="lucide:file-scan" text="Reading entire file" />
		{/if}
	</div>
</div>
