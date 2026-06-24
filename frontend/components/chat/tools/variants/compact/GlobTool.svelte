<script lang="ts">
	import type { ToolUseBlock, GlobInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GlobInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || '');
	const pathName = $derived(searchPath ? searchPath.split(/[/\\]/).pop() || searchPath : '');
	const isDirectory = $derived.by(() => {
		if (!searchPath) return true;
		const base = searchPath.split(/[/\\]/).pop() || '';
		return !base.includes('.');
	});
</script>

<ToolRow
	icon="lucide:folder-search"
	label="Listed files"
	filePath={searchPath}
	fileName={pathName}
	{isDirectory}
	subDetail={pattern}
/>