<script lang="ts">
	import type { ToolUseBlock, TodoWriteInput } from '$shared/types/unified';

	const { toolInput }: { toolInput: ToolUseBlock } = $props();
	const input = $derived(toolInput.input as TodoWriteInput);

	const todos = $derived(input.todos);
	const totalTodos = $derived(todos.length);
	const completedTodos = $derived(todos.filter((t) => t.status === 'completed').length);
	const percentage = $derived(totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0);
</script>

<div class="flex items-center gap-2 mb-2">
	<span class="font-medium text-sm text-slate-700 dark:text-slate-300">Task Planning</span>
	<div class="ml-auto text-xs text-slate-600 dark:text-slate-400">
		Progress: {percentage}%
	</div>
</div>

{#if totalTodos > 0}
	<div class="mb-4">
		<div class="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
			<div
				class="bg-slate-500 dark:bg-slate-400 h-1.5 rounded-full transition-all duration-300"
				style="width: {percentage}%"
			></div>
		</div>
	</div>
{/if}

<div class="space-y-2">
	{#each todos as todo}
		<div class="flex items-start gap-3 p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
			<div class="flex-1 min-w-0">
				<p class="text-sm text-slate-900 dark:text-slate-100 {todo.status === 'completed' ? 'line-through opacity-75' : ''}">
					{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
				</p>
			</div>
		</div>
	{/each}
</div>
