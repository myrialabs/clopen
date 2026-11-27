<!--
	The opened part of a compact tool row, indented under its label.
-->
<script lang="ts">
	import TextMessage from '../../../../formatters/TextMessage.svelte';
	import ToolFailure from '../../../ToolFailure.svelte';
	import { processAnsiCodes } from '$frontend/utils/terminal-formatter';
	import CodeBlock from './CodeBlock.svelte';
	import DiffBlock from './DiffBlock.svelte';
	import type { DetailView } from './details';

	const { views, failure }: { views: DetailView[]; failure: string | null } = $props();
</script>

<div class="pl-[22px] mt-0.5 mb-1.5 space-y-1.5 min-w-0">
	{#each views as view, i (i)}
		{#if view.kind === 'diff'}
			<DiffBlock oldString={view.oldString} newString={view.newString} label={view.label} />
		{:else if view.kind === 'code'}
			<CodeBlock code={view.code} type={view.tone ?? 'neutral'} label={view.label} />
		{:else if view.kind === 'terminal'}
			<div class="rounded border border-slate-200 dark:border-slate-700/60 bg-slate-950 dark:bg-black/40 overflow-hidden">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<pre class="text-[10px] font-mono text-slate-200 px-2.5 py-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{@html processAnsiCodes(view.code)}</pre>
			</div>
		{:else}
			<div>
				<span class="text-xs text-slate-400 dark:text-slate-500 mb-0.5 block">{view.label}:</span>
				<div class="max-h-60 overflow-y-auto rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-2.5 py-1.5 text-[12px] text-slate-600 dark:text-slate-300 leading-relaxed prose-compact">
					<TextMessage content={view.text} />
				</div>
			</div>
		{/if}
	{/each}
	{#if failure}
		<ToolFailure text={failure} compact />
	{/if}
</div>
