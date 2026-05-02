<script lang="ts">
	import type { ToolUseBlock, ListInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as ListInput);
	const result = $derived(toolInput.result);

	const path = $derived(input.path || '.');
	const ignore = $derived(input.ignore);
	const hasIgnore = $derived(!!ignore && ignore.length > 0);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100 truncate" title={path}>
			Listing: <span class="font-mono">{path}</span>
		</h3>
		<p class="text-xs text-slate-600 dark:text-slate-400 truncate">
			directory contents
		</p>
	</div>

	{#if hasIgnore}
		<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
			<div class="flex gap-x-3 gap-y-2 flex-wrap">
				<InfoLine icon="lucide:eye-off" text="Ignore: {ignore!.join(', ')}" title="Ignore: {ignore!.join(', ')}" />
			</div>
		</div>
	{/if}
</div>

{#if result?.content}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<TextMessage content={typeof result.content === 'string' ? result.content : JSON.stringify(result.content)} />
	</div>
{/if}
