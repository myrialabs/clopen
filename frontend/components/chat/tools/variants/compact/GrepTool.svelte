<script lang="ts">
	import type { ToolUseBlock, GrepInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GrepInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || '');
	const pathName = $derived(searchPath ? searchPath.split(/[/\\]/).pop() || searchPath : '');

	// Count results from tool result if available
	const resultCount = $derived.by(() => {
		const result = (toolInput as any).result;
		if (!result?.content) return '';
		const text = typeof result.content === 'string' ? result.content :
			result.content[0]?.text ?? '';
		const matches = text.match(/(\d+)\s+results?/i);
		if (matches) return `${matches[1]} results`;
		const lines = text.split('\n').filter((l: string) => l.trim());
		return lines.length > 0 ? `${lines.length} results` : '';
	});

	const meta = $derived(resultCount);
	const isDirectory = $derived.by(() => {
		if (!searchPath) return true;
		const base = searchPath.split(/[/\\]/).pop() || '';
		return !base.includes('.');
	});

	let expanded = $state(false)
</script>

<ToolRow
	icon="lucide:search"
	label="Searched for regex"
	filePath={searchPath}
	fileName={pathName}
	{isDirectory}
	{meta}
	expandable={Boolean(pattern)}
	bind:expanded
/>

{#if expanded && pattern}
	<div class="pl-[22px] mt-0.5 mb-0.5">
		<code class="text-[10px] font-mono bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-300 px-2 pt-[3px] pb-[1px] rounded border border-slate-200 dark:border-slate-700/60 block max-w-full truncate leading-none" title={pattern}>{pattern}</code>
	</div>
{/if}