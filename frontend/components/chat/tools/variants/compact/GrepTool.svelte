<script lang="ts">
	import type { ToolUseBlock, GrepInput } from '$shared/types/unified';
	import { ToolRow, withScope } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GrepInput);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || '');

	// Count results from tool result if available
	const resultSummary = $derived.by(() => {
		const result = (toolInput as any).result;
		if (!result?.content) return '';
		const text = typeof result.content === 'string' ? result.content :
			result.content[0]?.text ?? '';
		if (/no matches|no results/i.test(text)) return 'no results';
		const matches = text.match(/(\d+)\s+results?/i);
		if (matches) return `${matches[1]} results`;
		const lines = text.split('\n').filter((l: string) => l.trim());
		return lines.length > 0 ? `${lines.length} results` : 'no results';
	});

	const meta = $derived(withScope(searchPath, resultSummary));
</script>

<ToolRow
	icon="lucide:search"
	label="Searched for regex"
	inlineCode={pattern}
	{meta}
/>
