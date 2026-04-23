<script lang="ts">
	import type { ToolUseBlock, GrepInput } from '$shared/types/unified';
	import type { IconName } from '$shared/types/ui';
	import { InfoLine } from './components';
	import { truncateText } from '../../../shared/utils';
	import CodeBlock from './components/CodeBlock.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as GrepInput);
	const result = $derived(toolInput.result);

	const pattern = $derived(input.pattern || '');
	const searchPath = $derived(input.path || 'current directory');

	// Get active search parameters for display
	function getActiveParameters() {
		const params: { label: string; value: string; icon: IconName }[] = [];

		params.push({ label: 'Output', value: input.outputMode || 'files_with_matches', icon: 'lucide:filter' });

		if (input.glob) {
			params.push({ label: 'Glob', value: input.glob, icon: 'lucide:folder-search' });
		}

		if (input.type) {
			params.push({ label: 'File type', value: input.type, icon: 'lucide:file-type' });
		}

		if (input.caseInsensitive) {
			params.push({ label: 'Case insensitive', value: '', icon: 'lucide:case-sensitive' });
		}

		if (input.lineNumbers) {
			params.push({ label: 'Line numbers', value: '', icon: 'lucide:hash' });
		}

		if (input.afterContext) {
			params.push({ label: 'After context', value: `${input.afterContext} lines`, icon: 'lucide:arrow-down' });
		}

		if (input.beforeContext) {
			params.push({ label: 'Before context', value: `${input.beforeContext} lines`, icon: 'lucide:arrow-up' });
		}

		if (input.context) {
			params.push({ label: 'Context', value: `${input.context} lines`, icon: 'lucide:arrow-up-down' });
		}

		if (input.headLimit) {
			params.push({ label: 'Limit', value: `${input.headLimit} results`, icon: 'lucide:list-end' });
		}

		if (input.multiline) {
			params.push({ label: 'Multiline', value: '', icon: 'lucide:text' });
		}

		return params;
	}

	const activeParameters = $derived(getActiveParameters());
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100 truncate" title={pattern}>
			Searching for: <span class="font-mono">{pattern}</span>
		</h3>
		<p class="text-xs text-slate-600 dark:text-slate-400 truncate" title={searchPath}>
			in {searchPath}
		</p>
	</div>

	{#if activeParameters.length > 0}
		<div class="border-t border-slate-200 dark:border-slate-700 pt-3">
			<div class="flex gap-x-3 gap-y-2 flex-wrap">
				{#each activeParameters as param}
					<InfoLine icon={param.icon} text={param.value == '' ? param.label : param.value} title={param.value == '' ? param.label : `${param.label}: ${param.value}`} />
				{/each}
			</div>
		</div>
	{/if}
</div>

<!-- Tool Result -->
{#if result?.content}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={result.content} type="neutral" label="Output" />
	</div>
{/if}
