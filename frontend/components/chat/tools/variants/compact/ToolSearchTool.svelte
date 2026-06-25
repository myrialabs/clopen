<script lang="ts">
	import type { ToolUseBlock, ToolSearchInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ToolSearchInput);
</script>

<ToolRow icon="lucide:search-code" label="Searched tools" inlineCode={input.query || ''} />
