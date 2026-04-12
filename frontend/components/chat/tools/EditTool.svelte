<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { FileHeader, DiffBlock } from './components';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const oldString = $derived(input.oldString || '');
	const newString = $derived(input.newString || '');
	const replaceAll = $derived(input.replaceAll || false);

	const badges = $derived(replaceAll ? [{ text: 'Replace All', color: 'bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300' }] : []);
</script>

<FileHeader
	{filePath}
	{fileName}
	iconColor="text-emerald-600 dark:text-emerald-400"
	{badges}
/>

<!-- Code Changes -->
<div class="mt-4">
	<DiffBlock {oldString} {newString} label="Edit" />
</div>
