<script lang="ts">
	import type { EditToolInput } from '$shared/types/messaging';
	import { FileHeader, DiffBlock } from './components';
	import Icon from '$frontend/lib/components/common/Icon.svelte';

	const { toolInput }: { toolInput: EditToolInput } = $props();

	const filePath = toolInput.input.file_path || '';
	const fileName = filePath.split(/[/\\]/).pop() || filePath || 'unknown';
	const oldString = toolInput.input.old_string || '';
	const newString = toolInput.input.new_string || '';
	const replaceAll = toolInput.input.replace_all || false;

	const badges = replaceAll ? [{ text: 'Replace All', color: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300' }] : [];
</script>

<FileHeader
	{filePath}
	{fileName}
	iconColor="text-emerald-600 dark:text-emerald-400"
	{badges}
/>

<!-- Replace All Info -->
<!-- {#if replaceAll}
	<div class="mt-3 flex items-start gap-2 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md p-3">
		<Icon name="lucide:info" class="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
		<p class="text-xs text-amber-700 dark:text-amber-300">
			This edit will replace <strong>all occurrences</strong> of the old string in the file. The actual file changes may affect multiple lines beyond what is shown in the diff preview below.
		</p>
	</div>
{/if} -->

<!-- Code Changes -->
<div class="mt-4">
	<DiffBlock {oldString} {newString} label="Edit" />
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