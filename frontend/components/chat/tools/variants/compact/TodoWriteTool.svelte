<script lang="ts">
	import type { ToolUseBlock, TodoWriteInput } from '$shared/types/unified';
	import Icon from '$frontend/components/common/display/Icon.svelte';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TodoWriteInput);

	const todos = $derived(input.todos);
	const total = $derived(todos.length);
	const completed = $derived(todos.filter(t => t.status === 'completed').length);
	const inProgress = $derived(todos.find(t => t.status === 'in_progress'));
</script>

<div class="min-w-0">
	<!-- Header row — matches ToolRow layout -->
	<div class="flex items-start gap-2 py-[2px] min-w-0">
		<span class="relative shrink-0 w-[14px] mt-[1px] flex items-center justify-center text-slate-500 dark:text-slate-400 z-10">
			<span class="absolute inset-0 -m-[3px] rounded bg-slate-50 dark:bg-slate-900"></span>
			<Icon name="lucide:list-todo" class="relative w-[13px] h-[13px]" />
		</span>
		<div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 flex-1 min-w-0">
			<span class="text-[12px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">Todo</span>
			<span class="text-[12px] text-slate-700 dark:text-slate-200">{completed}/{total} done</span>
			{#if inProgress}
				<span class="text-[10px] text-slate-400 dark:text-slate-500 min-w-0 break-words">{inProgress.activeForm || inProgress.content}</span>
			{/if}
		</div>
	</div>
	<!-- Todo list — aligned under the label -->
	<div class="space-y-0.5 pl-[22px]">
		{#each todos as todo}
			<div class="flex items-center gap-1.5 text-sm text-slate-500 dark:text-slate-400">
				<span class="shrink-0 w-3 text-center text-xs">
					{#if todo.status === 'completed'}✓{:else if todo.status === 'in_progress'}›{:else}·{/if}
				</span>
				<span class="{todo.status === 'completed' ? 'line-through opacity-50' : ''}">
					{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
				</span>
			</div>
		{/each}
	</div>
</div>
