<script lang="ts">
	import type { ExitPlanModeToolInput } from '$shared/types/messaging';
	import { InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ExitPlanModeToolInput } = $props();

	const plan = (toolInput.input as any).plan as string || '';
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<!-- Plan Info -->
	<div class="flex gap-3 mb-2">
		<InfoLine icon="lucide:map" text="Exiting plan mode with proposed plan" />
	</div>
	
	<!-- Plan Content -->
	<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
		<CodeBlock code={plan} type="neutral" label="Plan" />
	</div>
</div>

<!-- Tool Result -->
{#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
{/if}