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
	const chips = $derived(searchPath && pathName ? [pathName] : []);
</script>

<ToolRow
	icon="lucide:search"
	label="Searched for regex"
	subDetail={pattern}
	{meta}
	{chips}
/>

