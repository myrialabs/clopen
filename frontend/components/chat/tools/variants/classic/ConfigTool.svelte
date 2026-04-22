<script lang="ts">
	import type { ToolUseBlock, ConfigInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ConfigInput);
	const result = $derived(toolInput.result);

	const key = $derived(input.key || '');
	const value = $derived(input.value);
	const mode = $derived(value === undefined ? 'read' : 'write');
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="space-y-1">
		<InfoLine icon="lucide:settings" text="{mode === 'read' ? 'Read' : 'Set'} config: {key}" />
		{#if value !== undefined}
			<InfoLine icon="lucide:equal" text="= {value}" />
		{/if}
	</div>
</div>

{#if result?.content}
	<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
{/if}
