<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const replaceAll = $derived(input.replaceAll || false);

	const additions = $derived(input.newString ? input.newString.split('\n').length : 0);
	const deletions = $derived(input.oldString ? input.oldString.split('\n').length : 0);

	const badges = $derived.by(() => {
		const list: string[] = [];
		if (additions > 0) list.push(`+${additions}`);
		if (deletions > 0) list.push(`-${deletions}`);
		if (replaceAll) list.push('replace all');
		return list;
	});
</script>

<FileHeader {filePath} {fileName} operation="Edit" {badges} />
