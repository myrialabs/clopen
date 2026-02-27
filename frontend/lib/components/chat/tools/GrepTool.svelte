<script lang="ts">
	import type { GrepToolInput } from '$shared/types/messaging';
	import type { IconName } from '$shared/types/ui';
	import { InfoLine } from './components';
	import { formatPath, truncateText } from '../shared/utils';
	import CodeBlock from './components/CodeBlock.svelte';

	const { toolInput }: { toolInput: GrepToolInput } = $props();

	const pattern = toolInput.input.pattern || '';
	const searchPath = toolInput.input.path || 'current directory';

	// Get active search parameters for display
	function getActiveParameters() {
		const params: { label: string; value: string; icon: IconName }[] = [];

		params.push({ label: 'Output', value: toolInput.input.output_mode || 'files_with_matches', icon: 'lucide:filter' });

		if (toolInput.input.glob) {
			params.push({ label: 'Glob', value: toolInput.input.glob, icon: 'lucide:folder-search' });
		}

		if (toolInput.input.type) {
			params.push({ label: 'File type', value: toolInput.input.type, icon: 'lucide:file-type' });
		}

		if (toolInput.input['-i']) {
			params.push({ label: 'Case insensitive', value: '', icon: 'lucide:case-sensitive' });
		}

		if (toolInput.input['-n']) {
			params.push({ label: 'Line numbers', value: '', icon: 'lucide:hash' });
		}

		if (toolInput.input['-A']) {
			params.push({ label: 'After context', value: `${toolInput.input['-A']} lines`, icon: 'lucide:arrow-down' });
		}

		if (toolInput.input['-B']) {
			params.push({ label: 'Before context', value: `${toolInput.input['-B']} lines`, icon: 'lucide:arrow-up' });
		}

		if (toolInput.input['-C']) {
			params.push({ label: 'Context', value: `${toolInput.input['-C']} lines`, icon: 'lucide:arrow-up-down' });
		}

		if (toolInput.input.head_limit) {
			params.push({ label: 'Limit', value: `${toolInput.input.head_limit} results`, icon: 'lucide:list-end' });
		}

		if (toolInput.input.multiline) {
			params.push({ label: 'Multiline', value: '', icon: 'lucide:text' });
		}

		return params;
	}

	const activeParameters = getActiveParameters();

	const formattedPattern = truncateText(pattern, 40);
	const formattedPath = formatPath(searchPath);
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="mb-2">
		<h3 class="font-medium text-slate-900 dark:text-slate-100 truncate" title={pattern}>
			Searching for: <span class="font-mono">{formattedPattern}</span>
		</h3>
		<p class="text-xs text-slate-600 dark:text-slate-400 truncate" title={searchPath}>
			in {formattedPath}
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
{#if toolInput.$result?.content}
	<div class="mt-4 bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
		<CodeBlock code={toolInput.$result.content} type="neutral" label="Output" />
	</div>
{/if}