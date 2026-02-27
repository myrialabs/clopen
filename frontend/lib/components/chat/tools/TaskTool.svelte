<script lang="ts">
	import type { TaskToolInput } from '$shared/types/messaging';
	import { InfoLine, CodeBlock } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: TaskToolInput } = $props();

	const showFullPrompt = $state(false);

	// Format description for display
	function formatDescription(desc: string): string {
		if (desc.length > 50) {
			return desc.substring(0, 47) + '...';
		}
		return desc;
	}

	const formattedDesc = formatDescription(toolInput.input.description || '');
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100">
			{formattedDesc}
		</h3>
		<p class="text-xs text-slate-600 dark:text-slate-400" title={toolInput.input.subagent_type}>
			Using {toolInput.input.subagent_type} agent
		</p>
	</div>

	<!-- <div class="border-t border-slate-200 dark:border-slate-700 pt-3">
		<div class="flex gap-3">
			<InfoLine icon="lucide:file-text" text="Full task prompt provided" />
			<button
				onclick={() => showFullPrompt = !showFullPrompt}
				class="text-xs text-violet-600 dark:text-violet-400 hover:underline"
			>
				{showFullPrompt ? 'Hide' : 'Show'} details
			</button>
		</div>

		{#if showFullPrompt}
			<div class="mt-2 p-3 bg-slate-50 dark:bg-slate-800 rounded-md border border-slate-200 dark:border-slate-700">
				<pre class="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{toolInput.input.prompt}</pre>
			</div>
		{/if}
	</div> -->
</div>

<TextMessage content={toolInput.input.prompt} />

<!-- Tool Result -->
<!-- {#if toolInput.$result}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		{#if typeof toolInput.$result.content === 'string'}
			<TextMessage content={toolInput.$result.content} />
		{:else}
			<TextMessage content={JSON.stringify(toolInput.$result.content)} />
		{/if}
	</div>
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={toolInput.input.prompt} type="neutral" label="Output" />
	</div>
{/if} -->