<script lang="ts">
	import type { ToolUseBlock, GlobInput } from '$shared/types/unified';
	import { ToolRow, projectScope } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GlobInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || '');
	const meta = $derived(projectScope(searchPath));
</script>

<ToolRow
	icon="lucide:folder-search"
	label="Listed files"
	inlineCode={pattern}
	{meta}
/>
