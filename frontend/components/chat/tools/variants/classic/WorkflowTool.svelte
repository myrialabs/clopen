<script lang="ts">
	import type { ToolUseBlock, WorkflowInput, SubAgentToolActivity } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../../../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WorkflowInput);
	const script = $derived(input.script || '');
	const workflowName = $derived(input.name || script.match(/\bname\s*:\s*['"]([^'"]+)['"]/)?.[1] || 'workflow');
	const description = $derived(input.description || script.match(/\bdescription\s*:\s*['"]([^'"]+)['"]/)?.[1] || 'Orchestrating agents');
	const phases = $derived([...script.matchAll(/\{\s*title\s*:\s*['"]([^'"]+)['"](?:\s*,\s*detail\s*:\s*['"]([^'"]*)['"])?/g)]
		.map(match => ({ title: match[1], detail: match[2] || '' })));
	const activities = $derived(toolInput.subActivities || []);
	const result = $derived(toolInput.result);
	const showResult = $derived(Boolean(
		result?.content
		&& !(typeof result.content === 'string' && result.content.startsWith('Workflow launched in background.'))
	));

	function brief(activity: SubAgentToolActivity): string {
		const raw = activity.input as Record<string, unknown>;
		return String(raw.description ?? raw.command ?? raw.filePath ?? raw.pattern ?? raw.query ?? '');
	}
</script>

<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2">
	<div class="space-y-1">
		<InfoLine icon="lucide:workflow" text={workflowName} />
		<InfoLine icon="lucide:align-left" text={description} />
		{#if input.resumeFromRunId}<InfoLine icon="lucide:rotate-cw" text="Resume {input.resumeFromRunId}" />{/if}
	</div>
	{#if phases.length > 0}
		<div class="mt-2 flex flex-wrap gap-1.5">
			{#each phases as phase, index}
				<span class="text-[11px] rounded bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 px-2 py-1" title={phase.detail}>
					{index + 1}. {phase.title}
				</span>
			{/each}
		</div>
	{/if}
</div>

{#if activities.length > 0}
	<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2">
		<div class="text-xs text-slate-500 dark:text-slate-400 mb-2">{activities.length} workflow activities:</div>
		<div class="max-h-80 overflow-y-auto">
			<ul class="list-disc pl-5 space-y-0.5">
				{#each activities as activity}
					{#if activity.type === 'tool_use'}
						<li class="text-xs text-slate-600 dark:text-slate-400">
							<span class="font-medium">{activity.name}</span>
							{#if brief(activity)}<span class="ml-1 opacity-60">{brief(activity)}</span>{/if}
						</li>
					{:else}<li class="text-xs text-slate-600 dark:text-slate-400">{activity.text}</li>{/if}
				{/each}
			</ul>
		</div>
	</div>
{/if}

{#if showResult && result}<TextMessage content={result.content} />{/if}
