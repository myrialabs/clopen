<script lang="ts">
	import type { ToolUseBlock, PatchInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as PatchInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
</script>

<FileHeader {filePath} {fileName} operation="Patch" />
