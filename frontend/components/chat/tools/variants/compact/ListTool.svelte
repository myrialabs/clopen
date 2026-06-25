<script lang="ts">
	import type { ToolUseBlock, ListInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListInput);

	const path = $derived(input.path || '.');
	const pathName = $derived(path.split(/[/\\]/).pop() || path);
</script>

<ToolRow icon="lucide:folder" label="Listed directory" filePath={path} fileName={pathName} isDirectory />

