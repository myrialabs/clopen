<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { IconName } from '$shared/types/ui/icons';
	import { removeCommonIndentation } from '../../shared/utils';
	import { isTerminalOutput, processAnsiCodes, escapeHtml } from '$frontend/lib/utils/terminalFormatter';

	interface Props {
		code: string;
		type: 'add' | 'remove' | 'neutral';
		label?: string;
		showTruncation?: boolean;
	}

	const { code, type, label }: Props = $props();

	function formatCode(code: string) {
		// First remove common indentation
		const cleanCode = removeCommonIndentation(code);

		// Check if it's terminal output and process ANSI codes if needed
		if (isTerminalOutput(cleanCode)) {
			// For terminal output, process ANSI codes but don't escape HTML
			// since we're displaying it in a <pre> tag
			return processAnsiCodes(cleanCode);
		}

		// For non-terminal code, don't escape HTML either since it's in <pre>
		// The <pre> tag already handles text display safely
		return cleanCode;
	}

	const styles = {
		add: {
			icon: 'lucide:circle-plus' as IconName,
			iconColor: 'text-green-500',
			labelColor: 'text-green-700 dark:text-green-300',
			bgColor: 'bg-green-50 dark:bg-green-950',
			borderColor: 'border-green-200 dark:border-green-800',
			textColor: 'text-green-800 dark:text-green-200'
		},
		remove: {
			icon: 'lucide:circle-minus' as IconName,
			iconColor: 'text-red-500',
			labelColor: 'text-red-700 dark:text-red-300',
			bgColor: 'bg-red-50 dark:bg-red-950',
			borderColor: 'border-red-200 dark:border-red-800',
			textColor: 'text-red-800 dark:text-red-200'
		},
		neutral: {
			icon: 'lucide:code' as IconName,
			iconColor: 'text-slate-500',
			labelColor: 'text-slate-700 dark:text-slate-300',
			bgColor: 'bg-slate-50 dark:bg-slate-950',
			borderColor: 'border-slate-200 dark:border-slate-800',
			textColor: 'text-slate-800 dark:text-slate-200'
		}
	};

	const style = styles[type];
	const formattedCode = formatCode(code);
	const isTerminal = isTerminalOutput(code);
</script>

<div>
	{#if label}
		<div class="flex items-center gap-2 mb-2">
			<!-- <Icon name={style.icon} class="{style.iconColor} w-4 h-4" /> -->
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
	</div>
</div>