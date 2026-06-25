<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();

	const originalName = $derived(toolInput.name.startsWith('Unknown:')
		? toolInput.name.slice('Unknown:'.length)
		: toolInput.name);
</script>

<ToolRow icon="lucide:circle-alert" label="Unhandled" inlineCode={originalName} />
