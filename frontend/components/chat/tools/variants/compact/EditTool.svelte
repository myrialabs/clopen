<script lang="ts">
	import type { ToolUseBlock, EditInput } from '$shared/types/unified';
	import { FileHeader } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as EditInput);

	const filePath = $derived(input.filePath || '');
	const fileName = $derived(filePath.split(/[/\\]/).pop() || filePath || 'unknown');
	const replaceAll = $derived(input.replaceAll || false);

	const badges = $derived(replaceAll ? [{ text: 'replace all', color: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' }] : []);
</script>

<FileHeader {filePath} {fileName} operation="Edit" {badges} />
