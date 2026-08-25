<script lang="ts">
	import type { SendInboxInput, ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as SendInboxInput);
</script>
<ToolRow icon="lucide:inbox" label="SendInbox" inlineCode={input.summary || 'context'} />
