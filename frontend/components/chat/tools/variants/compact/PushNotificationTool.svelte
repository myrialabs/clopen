<script lang="ts">
	import type { ToolUseBlock, PushNotificationInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as PushNotificationInput);
</script>

<ToolRow icon="lucide:bell" label="Notify" detail={input.title || 'notification'} meta={input.message || ''} />
