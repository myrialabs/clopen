<script lang="ts">
	import type { ToolUseBlock, ReadInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReadInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const hasLimit = $derived(input.limit !== undefined);
	const hasOffset = $derived(input.offset !== undefined);
	const meta = $derived.by(() => {
		if (!hasLimit && !hasOffset) return '';
		const start = hasOffset ? (input.offset as number) : 0;
		if (hasLimit) return `${start}-${start + (input.limit as number)}`;
		return `from ${start}`;
	});
	const badges = $derived(meta ? [meta] : []);
</script>

<FileHeader {filePath} {fileName} operation="Read" {badges} />
