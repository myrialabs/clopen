<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { FileHeader, DiffBlock } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const oldString = $derived(input.oldString || '');
	const newString = $derived(input.newString || '');
	const replaceAll = $derived(input.replaceAll || false);

	const badges = $derived(replaceAll ? [{ text: 'Replace All', color: 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300' }] : []);
</script>

<FileHeader
	{filePath}
	{fileName}
	{badges}
	iconColor="text-emerald-600 dark:text-emerald-400"
/>

<!-- Code Changes -->
<div class="mt-4">
	<DiffBlock {oldString} {newString} label="Edit" />
</div>
