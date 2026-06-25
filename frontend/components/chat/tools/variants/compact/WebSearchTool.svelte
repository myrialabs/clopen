<script lang="ts">
	import type { ToolUseBlock, WebSearchInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WebSearchInput);

	const query = $derived(input.query || '');
	const domains = $derived(input.allowedDomains?.join(', ') || '');
</script>

<ToolRow icon="lucide:globe" label="Searched web" inlineCode={query} meta={domains} />
