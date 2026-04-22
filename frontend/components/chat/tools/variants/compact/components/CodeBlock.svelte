<script lang="ts">
	import { removeCommonIndentation } from '../../../../shared/utils';
	import { isTerminalOutput, processAnsiCodes } from '$frontend/utils/terminal-formatter';

	const MAX_LINES = 40;

	interface Props {
		code: string;
		type: 'add' | 'remove' | 'neutral';
		label?: string;
	}

	const { code, type, label }: Props = $props();

	let expanded = $state(false);

	const truncation = $derived.by(() => {
		const lines = code.split('\n');
		if (lines.length <= MAX_LINES || expanded) return { code, truncated: false, totalLines: lines.length };
		return { code: lines.slice(0, MAX_LINES).join('\n'), truncated: true, totalLines: lines.length };
	});

	function formatCode(raw: string) {
		const cleanCode = removeCommonIndentation(raw);
		return isTerminalOutput(cleanCode) ? processAnsiCodes(cleanCode) : cleanCode;
	}

	const bgColor = $derived(type === 'add' ? 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800 text-green-800 dark:text-green-200'
		: type === 'remove' ? 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800 text-red-800 dark:text-red-200'
		: 'bg-slate-50 dark:bg-slate-950 border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300');

	const formattedCode = $derived(formatCode(truncation.code));
	const isTerminal = $derived(isTerminalOutput(truncation.code));
</script>

<div>
	{#if label}
		<span class="text-xs text-slate-400 dark:text-slate-500 mb-0.5 block">{label}:</span>
	{/if}
	<div class="max-h-48 border rounded px-2 py-1.5 overflow-auto {bgColor}">
		{#if isTerminal}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<pre class="text-xs font-mono">{@html formattedCode}</pre>
		{:else}
			<pre class="text-xs font-mono">{formattedCode}</pre>
		{/if}
		{#if truncation.truncated}
			<button
				onclick={() => expanded = true}
				class="text-xs text-slate-500 hover:underline mt-1"
			>+{truncation.totalLines - MAX_LINES} more lines</button>
		{/if}
	</div>
</div>
