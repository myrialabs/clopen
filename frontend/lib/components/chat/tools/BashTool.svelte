<script lang="ts">
	import type { BashToolInput, BashOutputToolOutput } from '$shared/types/messaging';
	import { TerminalCommand } from './components';
	import CodeBlock from './components/CodeBlock.svelte';

	const { toolInput }: { toolInput: BashToolInput } = $props();

	const command = toolInput.input.command || '';
	const description = toolInput.input.description;
	const timeout = toolInput.input.timeout;
	const isBackground = toolInput.input.run_in_background;

	function parseBashOutputToolOutput(content: string): BashOutputToolOutput {
		const statusMatch = content.match(/<status>(.*?)<\/status>/);
		const stdoutMatch = content.match(/<stdout>(.*?)<\/stdout>/s);
		const timestampMatch = content.match(/<timestamp>(.*?)<\/timestamp>/);

		return {
			status: statusMatch ? statusMatch[1] as BashOutputToolOutput['status'] : 'completed',
			output: stdoutMatch ? stdoutMatch[1].trim() : ""
		};
	}

	// Parse the output content if it's from BashOutput format
	const outputContent = $derived.by(() => {
		if (!toolInput.$result?.content) return '';

		// Check if this is a background command that has been merged with BashOutput
		if (isBackground && toolInput.$result.content.includes('<status>')) {
			const parsed = parseBashOutputToolOutput(toolInput.$result.content);
			return parsed.output;
		}

		return toolInput.$result.content;
	});

</script>

<TerminalCommand {command} {description} {timeout} />

<!-- Tool Result -->
{#if outputContent}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={outputContent} type="neutral" label="Output" />
	</div>
{/if}