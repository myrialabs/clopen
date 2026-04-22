<script lang="ts">
	import type { ToolUseBlock } from '$shared/types/unified';
	import CodeBlock from './components/CodeBlock.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const result = $derived(toolInput.result);

	function parseMcpToolName(fullName: string): { server: string; tool: string } {
		const withoutPrefix = fullName.replace('mcp__', '');
		const parts = withoutPrefix.split('__');
		return { server: parts[0] || 'unknown', tool: parts[1] || 'unknown' };
	}

	const parsed = $derived(parseMcpToolName(toolInput.name));
	const server = $derived(parsed.server);
	const tool = $derived(parsed.tool);

	const resultContent = $derived.by(() => {
		if (!result?.content) return null;
		return typeof result.content === 'string' ? result.content : String(result.content);
	});

	const isError = $derived(typeof result?.content === 'string' && result.content.toLowerCase().includes('error:'));
</script>

<div class="space-y-1.5">
	<div class="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
		<span class="opacity-60">{server}</span>
		<span class="opacity-30">/</span>
		<span>{tool}</span>
	</div>
	{#if toolInput.input && Object.keys(toolInput.input).length > 0}
		<CodeBlock code={JSON.stringify(toolInput.input, null, 2)} type="neutral" label="Input" />
	{/if}
	{#if resultContent}
		<CodeBlock code={resultContent} type="neutral" label={isError ? 'Error' : 'Result'} />
	{/if}
</div>
