<script lang="ts">
	import type { ToolUseBlock, WebFetchInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WebFetchInput);
</script>

<ToolRow icon="lucide:globe" label="Fetched" inlineCode={input.url || ''} />
