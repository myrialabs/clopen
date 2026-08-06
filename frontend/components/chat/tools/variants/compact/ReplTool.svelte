<script lang="ts">
	import type { ToolUseBlock, ReplInput } from '$shared/types/unified';
	import { ToolRow } from './components';
	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ReplInput);
	const summary = $derived(input.description || input.code?.split('\n')[0] || 'JavaScript');
</script>
<ToolRow icon="lucide:square-function" label="REPL" inlineCode={summary} />
