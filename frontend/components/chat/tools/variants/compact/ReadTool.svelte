<script lang="ts">
	import type { ToolUseBlock, ReadInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const hasLimit = $derived(input.limit !== undefined);
	const hasOffset = $derived(input.offset !== undefined);
	const meta = $derived([
		hasOffset ? `from line ${input.offset}` : '',
		hasLimit ? `${input.limit} lines` : '',
	].filter(Boolean).join(' · '));
</script>

<div class="space-y-0.5">
	<FileHeader {filePath} {fileName} operation="Read" />
	{#if meta}
		<div class="text-xs text-slate-400 dark:text-slate-500">{meta}</div>
	{/if}
</div>
