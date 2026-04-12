<script lang="ts">
	import type { ToolUseBlock, WriteInput } from '$shared/types/unified';
	import { FileHeader, DiffBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WriteInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const content = $derived(input.content || '');
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
