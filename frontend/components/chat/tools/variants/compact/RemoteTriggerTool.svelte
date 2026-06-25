<script lang="ts">
	import type { ToolUseBlock, RemoteTriggerInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as RemoteTriggerInput);
</script>

<ToolRow icon="lucide:zap" label="Trigger" detail={input.name || 'remote trigger'} />
