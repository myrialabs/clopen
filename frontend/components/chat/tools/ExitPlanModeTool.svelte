<script lang="ts">
	import type { ToolUseBlock, ExitPlanModeInput } from '$shared/types/unified';
	import { InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ExitPlanModeInput);
	const result = $derived(toolInput.result);

	const plan = $derived((input as Record<string, unknown>).plan as string || '');
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-4">
	<!-- Plan Info -->
	<div class="flex gap-3 mb-2.5">
		<InfoLine icon="lucide:map" text="Exiting plan mode with proposed plan" />
	</div>

	<CodeBlock code={plan} type="neutral" />
</div>

<!-- Tool Result -->
{#if result}
	<div class="">
		{#if typeof result.content === 'string'}
			<TextMessage content={result.content} />
		{:else}
			<TextMessage content={JSON.stringify(result.content)} />
		{/if}
	</div>
{/if}
