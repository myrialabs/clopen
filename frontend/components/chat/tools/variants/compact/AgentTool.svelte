<script lang="ts">
	import { tick } from 'svelte';
	import type { ToolUseBlock, AgentInput, SubAgentToolActivity } from '$shared/types/unified';
	import { RailIcon, RowMeta, useCompactTool } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as AgentInput);

	const description = $derived(input.description || '');
	const subagentType = $derived(input.subagentType || 'general-purpose');
	const subMessages = $derived(toolInput.subActivities);
	const toolUseCount = $derived(subMessages?.filter(a => a.type === 'tool_use').length ?? 0);

	const tool = useCompactTool();
	const expandable = $derived(tool?.hasDetails ?? false);

	let scrollContainer: HTMLDivElement | undefined = $state();
	let stickToBottom = $state(true);

	function handleScroll() {
		if (!scrollContainer) return;
		const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
		stickToBottom = distanceFromBottom <= 16;
	}

	$effect(() => {
		const len = subMessages?.length ?? 0;
		if (len > 0 && scrollContainer && stickToBottom) {
			tick().then(() => {
				if (scrollContainer && stickToBottom) scrollContainer.scrollTop = scrollContainer.scrollHeight;
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

<div class="min-w-0">
	<!-- Header row — matches ToolRow layout, opens the prompt and result -->
	<div
		class="flex items-start gap-2 py-[2px] min-w-0 {expandable ? 'cursor-pointer' : ''}"
		role={expandable ? 'button' : undefined}
		tabindex={expandable ? 0 : undefined}
		aria-expanded={expandable ? tool?.expanded : undefined}
		onclick={() => expandable && tool?.toggle()}
		onkeydown={(e) => e.key === 'Enter' && expandable && tool?.toggle()}
	>
		<RailIcon icon="lucide:waypoints" />
		<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 flex-1 min-w-0">
			<span class="text-[12px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">Agent</span>
			<RowMeta />
			<span class="text-[12px] text-slate-700 dark:text-slate-200 min-w-0 break-words">{description || subagentType}</span>
			<span class="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">{subagentType}</span>
			{#if toolUseCount > 0}
				<span class="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">· {toolUseCount} tool{toolUseCount === 1 ? '' : 's'}</span>
			{/if}
		</div>
	</div>
	<!-- Sub-activity stream — aligned under the label -->
	{#if subMessages && subMessages.length > 0}
		<div bind:this={scrollContainer} onscroll={handleScroll} class="max-h-39 overflow-y-auto pl-[22px]">
			<ul class="space-y-0.5 pl-3 list-disc text-xs text-slate-500 dark:text-slate-400">
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
					{:else if activity.type === 'reasoning'}
						<li class="line-clamp-1 italic opacity-70">{activity.text}</li>
					{/if}
				{/each}
			</ul>
		</div>
	{/if}
</div>
