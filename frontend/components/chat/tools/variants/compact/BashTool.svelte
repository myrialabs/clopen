<script lang="ts">
	import type { ToolUseBlock, BashInput } from '$shared/types/unified';
	import { ToolRow } from './components';
	import { processAnsiCodes } from '$frontend/utils/terminal-formatter'

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as BashInput);

	const command = $derived(input.command || '');
	const description = $derived(input.description || '');
	const isBackground = $derived(input.runInBackground);
	const label = $derived(description || 'Ran');
	const chips = $derived(isBackground ? ['bg'] : []);

	// Extract output from tool result if available
	const output = $derived.by(() => {
		const result = (toolInput as any).result;
		if (!result?.content) return '';
		if (typeof result.content === 'string') return result.content;
		return result.content[0]?.text ?? '';
	});
	const hasOutput = $derived(Boolean(output && output.trim()));

	let expanded = $state(false);
</script>

<ToolRow
	icon="lucide:square-terminal"
	{label}
	subDetail={command}
	{chips}
	expandable={hasOutput}
	bind:expanded
/>

{#if expanded && hasOutput}
<div class="pl-[22px] mt-1 mb-1">
	<div class="rounded border border-slate-200 dark:border-slate-700/60 bg-slate-950 dark:bg-black/40 overflow-hidden">
		<!-- Terminal header -->
		<div class="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-700/60">
			<div class="w-2 h-2 rounded-full bg-blue-500 shrink-0"></div>
			<code class="text-[10px] font-mono text-slate-200 truncate">{command}</code>
		</div>
		<!-- Terminal output -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<pre
			class="text-[10px] font-mono text-slate-200 px-2.5 py-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">{@html processAnsiCodes(output.trim())}</pre>
	</div>
</div>
{/if}
