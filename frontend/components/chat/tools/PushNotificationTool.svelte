<script lang="ts">
	import type { ToolUseBlock, PushNotificationInput } from '$shared/types/unified';
	import { InfoLine } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as PushNotificationInput);

	const title = $derived(input.title || '');
	const message = $derived(input.message || '');
	const url = $derived(input.url);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:bell" text={title || 'Push notification'} />
		{#if message}
			<p class="text-xs text-slate-600 dark:text-slate-400 pl-5">{message}</p>
		{/if}
		{#if url}
			<InfoLine icon="lucide:link" text={url} />
		{/if}
	</div>
</div>
