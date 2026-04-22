<script lang="ts">
	import { removeCommonIndentation } from '../../../../shared/utils';
	import { isTerminalOutput, processAnsiCodes } from '$frontend/utils/terminal-formatter';

	const MAX_LINES = 80;

	interface Props {
		code: string;
		type: 'add' | 'remove' | 'neutral';
		label?: string;
		showTruncation?: boolean;
	}

	const { code, type, label }: Props = $props();

	let expanded = $state(false);

	const truncation = $derived.by(() => {
		const lines = code.split('\n');
		if (lines.length <= MAX_LINES || expanded) {
			return { code, truncated: false, totalLines: lines.length };
		}
		return {
			code: lines.slice(0, MAX_LINES).join('\n'),
			truncated: true,
			totalLines: lines.length
		};
	});

	function formatCode(raw: string) {
		const cleanCode = removeCommonIndentation(raw);
		if (isTerminalOutput(cleanCode)) {
			return processAnsiCodes(cleanCode);
		}
		return cleanCode;
	}

	const styles = {
		add: {
			labelColor: 'text-green-700 dark:text-green-300',
			bgColor: 'bg-green-50 dark:bg-green-950',
			borderColor: 'border-green-200 dark:border-green-800',
			textColor: 'text-green-800 dark:text-green-200'
		},
		remove: {
			labelColor: 'text-red-700 dark:text-red-300',
			bgColor: 'bg-red-50 dark:bg-red-950',
			borderColor: 'border-red-200 dark:border-red-800',
			textColor: 'text-red-800 dark:text-red-200'
		},
		neutral: {
			labelColor: 'text-slate-700 dark:text-slate-300',
			bgColor: 'bg-slate-50 dark:bg-slate-950',
			borderColor: 'border-slate-200 dark:border-slate-800',
			textColor: 'text-slate-800 dark:text-slate-200'
		}
	};

	const style = $derived(styles[type]);
	const formattedCode = $derived(formatCode(truncation.code));
	const isTerminal = $derived(isTerminalOutput(truncation.code));
</script>

<div>
	{#if label}
		<div class="flex items-center gap-2 mb-2">
			<span class="text-xs font-medium {style.labelColor}">{label}:</span>
		</div>
	{/if}
	<div class="max-h-72 {style.bgColor} border {style.borderColor} rounded-md py-2.5 px-3 whitespace-pre-wrap overflow-auto">
		{#if isTerminal}
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<pre class="text-xs {style.textColor} font-mono">{@html formattedCode}</pre>
		{:else}
			<pre class="text-xs {style.textColor} font-mono">{formattedCode}</pre>
		{/if}
		{#if truncation.truncated}
			<button
				onclick={() => expanded = true}
				class="w-full flex mt-2 text-xs text-slate-500 dark:text-slate-400 hover:underline cursor-pointer"
			>
				Show all {truncation.totalLines} lines ({truncation.totalLines - MAX_LINES} more)
			</button>
		{/if}
	</div>
</div>
