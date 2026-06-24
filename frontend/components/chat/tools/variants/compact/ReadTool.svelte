<script lang="ts">
	import type { ToolUseBlock, ReadInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const hasLimit = $derived(input.limit !== undefined);
	const hasOffset = $derived(input.offset !== undefined);
	const meta = $derived.by(() => {
		if (!hasLimit && !hasOffset) return '';
		const start = hasOffset ? (input.offset as number) : 0;
		if (hasLimit) return `lines ${start} to ${start + (input.limit as number)}`;
		return `from ${start}`;
	});
</script>

<ToolRow icon="lucide:book-open" label="Read" {filePath} {fileName} {meta} />

