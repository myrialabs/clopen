<script lang="ts">
	import type { ToolUseBlock, PatchInput } from '$shared/types/unified';
	import { FileHeader, CodeBlock } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as PatchInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const patch = $derived(input.patch || '');
</script>

<FileHeader
	{filePath}
	{fileName}
	iconColor="text-emerald-600 dark:text-emerald-400"
/>

<div class="mt-4">
	<CodeBlock code={patch} type="neutral" label="Patch" />
</div>
