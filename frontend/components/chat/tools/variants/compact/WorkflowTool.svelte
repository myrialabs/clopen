<script lang="ts">
	import type { ToolUseBlock, WorkflowInput } from '$shared/types/unified';
	import { ToolRow } from './components';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as WorkflowInput);
	const script = $derived(input.script || '');
	const name = $derived(input.name || script.match(/\bname\s*:\s*['"]([^'"]+)['"]/)?.[1] || input.scriptPath || 'workflow');
	const count = $derived(toolInput.subActivities?.length || 0);
</script>

<div class="min-w-0">
	<ToolRow icon="lucide:workflow" label="Workflow" inlineCode={name} />
	{#if count > 0}
		<div class="max-h-39 overflow-y-auto pl-[34px] text-[10px] text-slate-400 dark:text-slate-500">
			{#each toolInput.subActivities as activity}
				<div class="truncate">
					{#if activity.type === 'tool_use'}<span class="font-medium">{activity.name}</span>{:else}{activity.text}{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
