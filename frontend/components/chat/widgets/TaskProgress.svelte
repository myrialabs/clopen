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
	import type {
		TodoItem,
		TodoWriteInput,
		TaskCreateInput,
		TaskUpdateInput,
		TaskStatus,
	} from '$shared/types/unified';

	/** Best-effort JSON parse of a tool result's content. */
	function parseResult(content: unknown): Record<string, unknown> | null {
		if (content && typeof content === 'object') return content as Record<string, unknown>;
		if (typeof content !== 'string') return null;
		try {
			const parsed = JSON.parse(content);
			return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Reconstruct the task list from the incremental Task tools
	 * (TaskCreate / TaskUpdate / TaskList — Claude SDK 0.3.142+). Unlike
	 * TodoWrite (which sends a full snapshot each call), these are deltas:
	 * the task id is returned in TaskCreate's result and referenced by
	 * TaskUpdate. We replay them in order to rebuild the current list, and
	 * fold in any TaskList snapshot. Returns null when no Task tool was used,
	 * so the TodoWrite path below stays the source of truth for other engines.
	 */
	const taskToolTodos = $derived.by((): TodoItem[] | null => {
		if (!sessionState.currentSession || sessionState.messages.length === 0) return null;

		const tasks = new Map<string, TodoItem>();
		const order: string[] = [];
		let sawTaskTool = false;
		// The harness assigns sequential integer ids ("1", "2", …) in creation
		// order; TaskCreate's result shape isn't reliably parseable, so we key
		// each created task by its creation index to match TaskUpdate.taskId.
		let createCount = 0;

		const upsert = (id: string, patch: Partial<TodoItem>) => {
			const existing = tasks.get(id);
			if (existing) {
				tasks.set(id, { ...existing, ...patch });
			} else {
				order.push(id);
				tasks.set(id, {
					content: patch.content ?? id,
					status: patch.status ?? 'pending',
					activeForm: patch.activeForm ?? patch.content ?? '',
				});
			}
		};

		for (const message of sessionState.messages) {
			if (message.type !== 'assistant' || !('content' in message)) continue;
			for (const item of message.content) {
				if (item.type !== 'tool_use') continue;

				if (item.name === 'TaskCreate') {
					sawTaskTool = true;
					const input = item.input as TaskCreateInput;
					const id = String(++createCount);
					upsert(id, {
						content: input.subject,
						activeForm: input.activeForm || input.subject,
						status: 'pending',
					});
				} else if (item.name === 'TaskUpdate') {
					sawTaskTool = true;
					const input = item.input as TaskUpdateInput;
					if (input.status === 'deleted') {
						if (tasks.delete(input.taskId)) {
							order.splice(order.indexOf(input.taskId), 1);
						}
						continue;
					}
					upsert(input.taskId, {
						...(input.subject ? { content: input.subject } : {}),
						...(input.activeForm ? { activeForm: input.activeForm } : {}),
						...(input.status ? { status: input.status as TaskStatus } : {}),
					});
				} else if (item.name === 'TaskList') {
					const result = parseResult(item.result?.content);
					const list = result?.tasks as Array<{ id: string; subject: string; status: TaskStatus }> | undefined;
					if (!Array.isArray(list)) continue;
					sawTaskTool = true;
					for (const t of list) {
						upsert(t.id, { content: t.subject, status: t.status });
					}
				}
			}
		}

		if (!sawTaskTool) return null;
		return order.map((id) => tasks.get(id)!);
	});

	const todoWriteTodos = $derived.by((): TodoItem[] | null => {
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

	const latestTodos = $derived(taskToolTodos ?? todoWriteTodos);

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
							class="flex items-start gap-2.5 px-2 py-1.5 rounded-md transition-colors">
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
