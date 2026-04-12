<script lang="ts">
	import type { ToolUseBlock, GlobInput } from '$shared/types/unified';
	import { InfoLine } from './components';
	import { formatPath } from '../shared/utils';
	import CodeBlock from './components/CodeBlock.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GlobInput);
	const result = $derived(toolInput.result);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || 'current directory');

	// Parse the pattern to get a readable description
	function getPatternDescription(p: string): string {
		if (p.includes('**/*.')) {
			const ext = p.split('**/*.')[1];
			return `all .${ext} files`;
		} else if (p.includes('**/')) {
			const rest = p.split('**/')[1];
			return `all ${rest} in subdirectories`;
		} else if (p.includes('*.')) {
			const ext = p.split('*.')[1];
			return `.${ext} files`;
		}
		return p;
	}

	const patternDescription = $derived(getPatternDescription(pattern));
	const formattedPath = $derived(formatPath(searchPath));
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100">
			Searching for {patternDescription}
		</h3>
		<p class="text-xs text-slate-600 dark:text-slate-400 truncate" title={searchPath}>
			in {formattedPath}
		</p>
	</div>

	<div class="flex gap-2 border-t border-slate-200/60 dark:border-slate-700/60 pt-2">
		<InfoLine icon="lucide:file-search-2" text={pattern} />
	</div>
</div>

<!-- Tool Result -->
{#if result?.content}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={result.content} type="neutral" label="Output" />
	</div>
{/if}
