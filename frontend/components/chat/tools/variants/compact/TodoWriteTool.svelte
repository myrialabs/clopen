<script lang="ts">
	import type { ToolUseBlock, TodoWriteInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TodoWriteInput);

	const todos = $derived(input.todos);
	const total = $derived(todos.length);
	const completed = $derived(todos.filter(t => t.status === 'completed').length);
	const inProgress = $derived(todos.find(t => t.status === 'in_progress'));
</script>

<div class="space-y-0.5">
	<div class="flex items-center gap-1.5 text-sm">
		<span class="text-slate-500 dark:text-slate-400 shrink-0">Todo:</span>
		<span class="text-slate-800 dark:text-slate-200">{completed}/{total} done</span>
		{#if inProgress}
			<span class="text-xs text-slate-400 dark:text-slate-500">· {inProgress.activeForm || inProgress.content}</span>
		{/if}
	</div>
	<div class="space-y-0.5 pl-4">
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
