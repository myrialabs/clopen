<!--
  Task Progress Component
  Static panel docked at the top of the AI Assistant chat.
  Shows the latest TodoWrite content with a collapsible task list.
-->

<script lang="ts">
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { todoPanelState, saveTodoPanelState } from '$frontend/stores/ui/todo-panel.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { slide } from 'svelte/transition';
	import type { TodoWriteInput } from '$shared/types/unified';

	const latestTodos = $derived.by(() => {
		if (!sessionState.currentSession || sessionState.messages.length === 0) {
			return null;
		}

		for (let i = sessionState.messages.length - 1; i >= 0; i--) {
			const message = sessionState.messages[i];

			if (message.type === 'assistant' && 'content' in message) {
				for (const item of message.content) {
					if (item.type === 'tool_use' && item.name === 'TodoWrite') {
						const input = item.input as TodoWriteInput;
						if (input.todos) return input.todos;
					}
				}
			}
		}

		return null;
	});

	const progress = $derived.by(() => {
		if (!latestTodos) return { completed: 0, total: 0, percentage: 0 };

		const total = latestTodos.length;
		const completed = latestTodos.filter((t) => t.status === 'completed').length;
		const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

		return { completed, total, percentage };
	});

	const shouldShow = $derived(latestTodos !== null && latestTodos.length > 0);

	const activeTodo = $derived(latestTodos?.find((t) => t.status === 'in_progress') ?? null);

	const headerLabel = $derived.by(() => {
		if (activeTodo) return activeTodo.activeForm || activeTodo.content;
		if (progress.total > 0 && progress.completed === progress.total) return 'All tasks completed';
		return 'Task Progress';
	});

	function toggleExpand() {
		todoPanelState.isExpanded = !todoPanelState.isExpanded;
		saveTodoPanelState();
	}

	function getStatusIcon(status: string) {
		switch (status) {
			case 'completed':
				return 'lucide:check';
			case 'in_progress':
				return 'lucide:loader';
			default:
				return 'lucide:circle';
		}
	}

	function getStatusColor(status: string) {
		switch (status) {
			case 'completed':
				return 'text-green-600 dark:text-green-400';
			case 'in_progress':
				return 'text-violet-600 dark:text-violet-400';
			default:
				return 'text-slate-400 dark:text-slate-500';
		}
	}
</script>

{#if shouldShow && !appState.isRestoring}
	<div
		transition:slide={{ duration: 220 }}
		class="shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
	>
		<button
			type="button"
			onclick={toggleExpand}
			class="w-full flex flex-col gap-1.5 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors"
			title={todoPanelState.isExpanded ? 'Collapse task list' : 'Expand task list'}
		>
			<div class="flex items-center gap-2 min-w-0">
				<Icon
					name={activeTodo ? 'lucide:loader' : 'lucide:list-todo'}
					class="w-4 h-4 shrink-0 {activeTodo
						? 'text-violet-600 dark:text-violet-400' + (appState.isLoading ? ' animate-spin' : '')
						: progress.total > 0 && progress.completed === progress.total
							? 'text-green-600 dark:text-green-400'
							: 'text-violet-600 dark:text-violet-400'}"
				/>
				<span
					class="flex-1 text-sm font-semibold truncate {activeTodo
						? 'text-violet-700 dark:text-violet-300'
						: 'text-slate-900 dark:text-slate-100'}"
				>
					{headerLabel}
				</span>
				<span class="text-xs font-medium text-slate-600 dark:text-slate-400 shrink-0 tabular-nums">
					{progress.completed}/{progress.total} · {progress.percentage}%
				</span>
				<Icon
					name={todoPanelState.isExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
					class="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0"
				/>
			</div>
			<div class="h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
				<div
					class="h-full bg-gradient-to-r from-violet-500 to-violet-600 transition-all duration-500 ease-out"
					style="width: {progress.percentage}%"
				></div>
			</div>
		</button>

		{#if todoPanelState.isExpanded}
			<div
				transition:slide={{ duration: 180 }}
				class="border-t border-slate-100 dark:border-slate-800"
			>
				<div class="task-list max-h-56 overflow-y-auto px-3 py-2 space-y-1">
					{#each latestTodos as todo, index}
						<div
							class="flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors
								{todo.status === 'in_progress' ? 'bg-violet-50 dark:bg-violet-900/20' : ''}
								{todo.status === 'completed' ? 'bg-green-50/60 dark:bg-green-900/10' : ''}"
						>
							<Icon
								name={getStatusIcon(todo.status)}
								class="w-3.5 h-3.5 mt-0.5 shrink-0 {getStatusColor(todo.status)} {todo.status === 'in_progress' && appState.isLoading ? 'animate-spin' : ''}"
							/>
							<p
								class="flex-1 text-sm leading-relaxed {todo.status === 'completed' ? 'line-through text-slate-500 dark:text-slate-400' : 'text-slate-800 dark:text-slate-200'}"
							>
								{todo.status === 'in_progress' && todo.activeForm
									? todo.activeForm
									: todo.content}
							</p>
							<span
								class="text-xs text-slate-400 dark:text-slate-500 mt-0.5 shrink-0 tabular-nums"
							>
								{index + 1}/{latestTodos?.length}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}

<style>
	.task-list::-webkit-scrollbar {
		width: 6px;
	}

	.task-list::-webkit-scrollbar-track {
		background: transparent;
	}

	.task-list::-webkit-scrollbar-thumb {
		background: rgb(203 213 225);
		border-radius: 3px;
	}

	:global(.dark) .task-list::-webkit-scrollbar-thumb {
		background: rgb(51 65 85);
	}

	.task-list::-webkit-scrollbar-thumb:hover {
		background: rgb(148 163 184);
	}

	:global(.dark) .task-list::-webkit-scrollbar-thumb:hover {
		background: rgb(71 85 105);
	}
</style>
