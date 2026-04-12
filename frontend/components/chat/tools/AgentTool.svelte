<script lang="ts">
	import { tick } from 'svelte';
	import type { ToolUseBlock, AgentInput, SubAgentActivity, SubAgentToolActivity } from '$shared/types/unified';
	import { InfoLine } from './components';
	import TextMessage from '../formatters/TextMessage.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as AgentInput);

	const description = $derived(input.description || '');
	const subagentType = $derived(input.subagentType || 'general-purpose');
	const subMessages = $derived(toolInput.subActivities);
	const toolUseCount = $derived(subMessages?.filter(a => a.type === 'tool_use').length ?? 0);
	const result = $derived(toolInput.result);

	let scrollContainer: HTMLDivElement | undefined = $state();

	// Auto-scroll to bottom when new activities arrive
	$effect(() => {
		const len = subMessages?.length ?? 0;
		if (len > 0 && scrollContainer) {
			tick().then(() => {
				if (scrollContainer) {
					scrollContainer.scrollTop = scrollContainer.scrollHeight;
				}
			});
		}
	});

	function getToolBrief(activity: SubAgentToolActivity): string {
		if (!activity.input) return '';
		switch (activity.name) {
			case 'Bash': return (activity.input as Record<string, string>).command || '';
			case 'Read': return (activity.input as Record<string, string>).filePath || '';
			case 'Write': return (activity.input as Record<string, string>).filePath || '';
			case 'Edit': return (activity.input as Record<string, string>).filePath || '';
			case 'Glob': return (activity.input as Record<string, string>).pattern || '';
			case 'Grep': return (activity.input as Record<string, string>).pattern || '';
			case 'WebFetch': return (activity.input as Record<string, string>).url || '';
			case 'WebSearch': return (activity.input as Record<string, string>).query || '';
			default: return '';
		}
	}
</script>

<!-- Header card -->
<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3 mb-2">
	<div class="space-y-1">
		<InfoLine icon="lucide:search" text={description} />
		<InfoLine icon="lucide:bot" text="Using {subagentType} agent" />
	</div>
</div>

<!-- Sub-agent tool calls (separate from header) -->
{#if subMessages && subMessages.length > 0}
<div class="bg-white dark:bg-slate-800 rounded-md border border-slate-200/60 dark:border-slate-700/60 p-3">
	<div class="text-xs text-slate-500 dark:text-slate-400 mb-2">
		{toolUseCount} tool {toolUseCount === 1 ? 'call' : 'calls'}:
	</div>
	<div bind:this={scrollContainer} class="max-h-64 overflow-y-auto wrap-break-word">
		<ul class="list-disc pl-5 space-y-0.5">
			{#each subMessages as activity}
				{#if activity.type === 'tool_use'}
					<li class="text-xs text-slate-600 dark:text-slate-400">
						<span class="font-medium">{activity.name}</span>
						{#if getToolBrief(activity)}
							<span class="text-slate-400 dark:text-slate-500 ml-1">{getToolBrief(activity)}</span>
						{/if}
					</li>
				{:else if activity.type === 'text'}
					<li class="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
						{activity.text}
					</li>
				{/if}
			{/each}
		</ul>
	</div>
</div>
{/if}
