<script lang="ts">
	import type { ToolUseBlock, GlobInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GlobInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || '');
	const pathName = $derived(searchPath ? searchPath.split(/[/\\]/).pop() || searchPath : '');
	const chips = $derived(pathName ? [pathName] : []);
</script>

<ToolRow icon="lucide:folder-search" label="Listed files" subDetail={pattern} {chips} />

