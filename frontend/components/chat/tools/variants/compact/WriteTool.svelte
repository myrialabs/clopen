<script lang="ts">
	import type { ToolUseBlock, WriteInput } from '$shared/types/unified';
	import { ToolRow } from './components';
	import { addAiChange } from '$frontend/utils/ai-changes';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WriteInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const lines = $derived(input.content ? input.content.split('\n').length : 0);
	const diff = $derived({ additions: lines });

	const hasResult = $derived(!!toolInput.result && !toolInput.result.isError);
	const content = $derived(input.content || '');
	let editIndex = $state<number | null>(null);

	$effect(() => {
		if (hasResult && filePath && content) {
			editIndex = addAiChange(filePath, '', content, toolInput.id);
		}
	});
</script>

<ToolRow icon="lucide:file-plus" label="Wrote" {filePath} {fileName} {diff} {editIndex} />

