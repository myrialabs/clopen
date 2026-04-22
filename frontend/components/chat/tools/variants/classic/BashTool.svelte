<script lang="ts">
	import type { ToolUseBlock, BashInput } from '$shared/types/unified';
	import { TerminalCommand } from './components';
	import CodeBlock from './components/CodeBlock.svelte';

	/** Parsed background bash output (from XML-formatted BashOutput tool result) */
	interface ParsedBashOutput {
		status: 'running' | 'completed' | 'failed';
		output: string;
	}

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as BashInput);
	const result = $derived(toolInput.result);

	const command = $derived(input.command || '');
	const description = $derived(input.description);
	const timeout = $derived(input.timeout);
	const isBackground = $derived(input.runInBackground);

	function parseBashOutputToolOutput(content: string): ParsedBashOutput {
		const statusMatch = content.match(/<status>(.*?)<\/status>/);
		const stdoutMatch = content.match(/<stdout>(.*?)<\/stdout>/s);

		return {
			status: statusMatch ? statusMatch[1] as ParsedBashOutput['status'] : 'completed',
			output: stdoutMatch ? stdoutMatch[1].trim() : ""
		};
	}

	// Parse the output content if it's from BashOutput format
	const outputContent = $derived.by(() => {
		if (!result?.content) return '';

		// Check if this is a background command that has been merged with BashOutput
		if (isBackground && result.content.includes('<status>')) {
			const parsed = parseBashOutputToolOutput(result.content);
			return parsed.output;
		}

		return result.content;
	});

</script>

<TerminalCommand {command} {description} {timeout} />

<!-- Tool Result -->
{#if outputContent}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={outputContent} type="neutral" label="Output" />
	</div>
{/if}
