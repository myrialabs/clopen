<script lang="ts">
	import type { WriteToolInput } from '$shared/types/messaging';
	import { FileHeader, DiffBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: WriteToolInput } = $props();

	const filePath = toolInput.input.file_path || '';
	const fileName = filePath.split(/[/\\]/).pop() || filePath || 'unknown';
	const content = toolInput.input.content || '';
</script>

<FileHeader
	{filePath}
	{fileName}
	iconColor="text-violet-600 dark:text-violet-400"
/>

<!-- Code Changes -->
<div class="mt-4">
	<DiffBlock oldString="" newString={content} label="Write" />
</div>

<!-- Tool Result -->
<!-- {#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if} -->