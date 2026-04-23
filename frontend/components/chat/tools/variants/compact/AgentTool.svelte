<script lang="ts">
	import { tick } from 'svelte';
	import type { ToolUseBlock, AgentInput, SubAgentToolActivity } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as AgentInput);

	const description = $derived(input.description || '');
	const subagentType = $derived(input.subagentType || 'general-purpose');
	const subMessages = $derived(toolInput.subActivities);
	const toolUseCount = $derived(subMessages?.filter(a => a.type === 'tool_use').length ?? 0);

	let scrollContainer: HTMLDivElement | undefined = $state();

	$effect(() => {
		const len = subMessages?.length ?? 0;
		if (len > 0 && scrollContainer) {
			tick().then(() => {
				if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
			});
		}
	});

	function getToolBrief(activity: SubAgentToolActivity): string {
		if (!activity.input) return '';
		switch (activity.name) {
			case 'Bash': return (activity.input as Record<string, string>).command || '';
			case 'Read': case 'Write': case 'Edit': return (activity.input as Record<string, string>).filePath || '';
			case 'Glob': case 'Grep': return (activity.input as Record<string, string>).pattern || '';
			case 'WebFetch': return (activity.input as Record<string, string>).url || '';
			case 'WebSearch': return (activity.input as Record<string, string>).query || '';
			default: return '';
		}
	}
</script>

<div class="space-y-0.5 text-sm">
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Agent:</span>
		<span class="text-slate-800 dark:text-slate-200">{description || subagentType}</span>
	</div>
	<div class="flex items-center flex-wrap gap-x-1.5 gap-y-0.5">
		<span class="text-xs text-slate-400 dark:text-slate-500">{subagentType}</span>
		{#if toolUseCount > 0}
			<span class="text-xs text-slate-400 dark:text-slate-500">· {toolUseCount} tool{toolUseCount === 1 ? '' : 's'}</span>
		{/if}
	</div>
	{#if subMessages && subMessages.length > 0}
		<div bind:this={scrollContainer} class="max-h-39 overflow-y-auto">
			<ul class="space-y-0.5 pl-5 list-disc text-sm text-slate-500 dark:text-slate-400">
				{#each subMessages as activity}
					{#if activity.type === 'tool_use'}
						<li>
							<span class="font-medium">{activity.name}</span>
							{#if getToolBrief(activity)}
								<span class="opacity-60 font-mono ml-1">{getToolBrief(activity)}</span>
							{/if}
						</li>
					{:else if activity.type === 'text'}
						<li class="line-clamp-1">{activity.text}</li>
					{/if}
				{/each}
			</ul>
		</div>
	{/if}
</div>
