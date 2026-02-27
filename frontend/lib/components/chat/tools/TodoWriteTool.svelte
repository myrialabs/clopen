<script lang="ts">
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import type { TodoWriteToolInput } from '$shared/types/messaging';
	import type { IconName } from '$shared/types/ui/icons';

	const { toolInput }: { toolInput: TodoWriteToolInput } = $props();

	const todos = toolInput.input.todos;
	const totalTodos = todos.length;
	const completedTodos = todos.filter((t) => t.status === 'completed').length;
	const percentage = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

	// Helper functions for todo items
	function getStatusIcon(status: string): IconName {
		switch (status) {
			case 'completed': return 'lucide:circle-check';
			case 'in_progress': return 'lucide:clock';
			case 'pending': return 'lucide:circle';
			default: return 'lucide:circle';
		}
	}

	function getStatusColor(status: string): string {
		switch (status) {
			case 'completed': return 'text-green-600 dark:text-green-400';
			case 'in_progress': return 'text-violet-600 dark:text-violet-400';
			case 'pending': return 'text-slate-500 dark:text-slate-400';
			default: return 'text-slate-500 dark:text-slate-400';
		}
	}

</script>

<!-- Header -->
<div class="flex items-center gap-2 mb-2">
	<Icon name="lucide:list-todo" class="text-violet-600 dark:text-violet-400 w-4 h-4" />
	<span class="font-medium text-sm text-violet-700 dark:text-violet-300">Task Planning</span>
	<div class="ml-auto flex items-center gap-4 text-sm">
		<div class="text-xs text-slate-600 dark:text-slate-400">
			Progress: {percentage}%
		</div>
	</div>
</div>

<!-- Progress Bar -->
{#if totalTodos > 0}
	<div class="mb-4">
		<div class="w-full bg-slate-200 dark:bg-slate-700 rounded-full h-1.5">
			<div
				class="bg-violet-600 dark:bg-violet-400 h-1.5 rounded-full transition-all duration-300"
				style="width: {percentage}%"
			></div>
		</div>
	</div>
{/if}

<!-- Todo List -->
<div class="space-y-2">
	{#each todos as todo}
		<div class="flex items-start gap-3 p-3 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700">
			<!-- Status Icon -->
			<Icon
				name={getStatusIcon(todo.status)}
				class="{getStatusColor(todo.status)} w-4 h-4 mt-0.5 flex-shrink-0"
			/>

			<!-- Content -->
			<div class="flex-1 min-w-0">
				<p class="text-sm text-slate-900 dark:text-slate-100 {todo.status === 'completed' ? 'line-through opacity-75' : ''}">
					{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
				</p>
			</div>
		</div>
	{/each}
</div>