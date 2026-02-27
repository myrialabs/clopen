<!--
  Floating Todo List Component
  Displays the latest TodoWrite content in a floating panel
  Updates when new TodoWrite messages arrive
  Session-aware to only show todos for current session
-->

<script lang="ts">
	import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
	import { appState } from '$frontend/lib/stores/core/app.svelte';
	import Icon from '$frontend/lib/components/common/Icon.svelte';
	import { fade, fly } from 'svelte/transition';
	import type { TodoWriteToolInput } from '$shared/types/messaging';

	let isExpanded = $state(true);
	let isMinimized = $state(false);

	// Extract the latest TodoWrite data from messages
	const latestTodos = $derived.by(() => {
		if (!sessionState.currentSession || sessionState.messages.length === 0) {
			return null;
		}

		// Search from newest to oldest for TodoWrite tool
		for (let i = sessionState.messages.length - 1; i >= 0; i--) {
			const message = sessionState.messages[i];

			if (message.type === 'assistant' && 'message' in message && message.message?.content) {
				const content = Array.isArray(message.message.content)
					? message.message.content
					: [message.message.content];

				// Find TodoWrite tool_use in content
				for (const item of content) {
					if (typeof item === 'object' && item && 'type' in item && item.type === 'tool_use') {
						const toolItem = item as any;
						if (toolItem.name === 'TodoWrite' && toolItem.input?.todos) {
							return toolItem.input.todos;
						}
					}
				}
			}
		}

		return null;
	});

	// Calculate progress
	const progress = $derived.by(() => {
		if (!latestTodos) return { completed: 0, total: 0, percentage: 0 };

		const total = latestTodos.length;
		const completed = latestTodos.filter((t: any) => t.status === 'completed').length;
		const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

		return { completed, total, percentage };
	});

	// Only show if we have todos and not restoring
	const shouldShow = $derived(latestTodos !== null && latestTodos.length > 0);

	function toggleExpand() {
		if (!isMinimized) {
			isExpanded = !isExpanded;
		}
	}

	function minimize() {
		isMinimized = true;
		isExpanded = false;
	}

	function restore() {
		isMinimized = false;
		isExpanded = true;
	}

	function getStatusIcon(status: string) {
		switch (status) {
			case 'completed':
				return 'lucide:check';
			case 'in_progress':
				return 'lucide:loader';
			case 'pending':
				return 'lucide:circle';
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
			case 'pending':
				return 'text-slate-400 dark:text-slate-500';
			default:
				return 'text-slate-400 dark:text-slate-500';
		}
	}
</script>

{#if shouldShow && !appState.isRestoring}
	{#if isMinimized}
		<!-- Minimized state - small floating button -->
		<button
			onclick={restore}
			class="fixed top-20 right-4 z-30 bg-violet-600 hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600 text-white rounded-full p-3 shadow-lg transition-all duration-200 flex items-center gap-2"
			transition:fly={{ x: 100, duration: 200 }}
		>
			<Icon name="lucide:list-todo" class="w-5 h-5" />
			<span class="text-sm font-medium">{progress.completed}/{progress.total}</span>
		</button>
	{:else}
		<!-- Floating panel -->
		<div
			class="fixed top-20 right-4 z-30 bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden transition-all duration-300"
			style="width: {isExpanded ? '330px' : '230px'}; max-height: {isExpanded ? '600px' : '56px'}"
			transition:fly={{ x: 100, duration: 300 }}
		>
			<!-- Header -->
			<div
				class="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-50 to-violet-50 dark:from-slate-800 dark:to-slate-800 border-b border-slate-200 dark:border-slate-700"
			>
				<div class="flex items-center gap-3">
					<Icon name="lucide:list-todo" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
					<div class="flex flex-col">
						<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">
							Task Progress
						</span>
						{#if !isExpanded}
							<span class="text-xs text-slate-600 dark:text-slate-400">
								{progress.completed}/{progress.total} tasks ({progress.percentage}%)
							</span>
						{/if}
					</div>
				</div>

				<div class="flex items-center gap-1">
					<button
						onclick={toggleExpand}
						class="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
						title={isExpanded ? 'Collapse' : 'Expand'}
					>
						<Icon
							name={isExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
							class="w-4 h-4 text-slate-600 dark:text-slate-400"
						/>
					</button>
					<button
						onclick={minimize}
						class="p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
						title="Minimize"
					>
						<Icon name="lucide:minus" class="w-4 h-4 text-slate-600 dark:text-slate-400" />
					</button>
				</div>
			</div>

			{#if isExpanded}
				<!-- Progress bar -->
				<div class="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
					<div class="flex items-center justify-between mb-2">
						<span class="text-xs font-medium text-slate-600 dark:text-slate-400">
							Overall Progress
						</span>
						<span class="text-xs font-semibold text-slate-900 dark:text-slate-100">
							{progress.percentage}%
						</span>
					</div>
					<div class="w-full h-1.5 bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
						<div
							class="h-full bg-gradient-to-r from-violet-500 to-violet-500 transition-all duration-500 ease-out"
							style="width: {progress.percentage}%"
						></div>
					</div>
					<div class="mt-1 text-xs text-slate-500 dark:text-slate-400">
						{progress.completed} of {progress.total} tasks
					</div>
				</div>

				<!-- Todo list -->
				<div class="overflow-y-auto" style="max-height: 420px">
					<div class="px-4 py-3 space-y-2">
						{#each latestTodos as todo, index}
							<div
								class="flex items-start gap-3 p-2.5 rounded-lg transition-colors {todo.status === 'in_progress' ? 'bg-violet-50 dark:bg-violet-900/20' : ''} {todo.status === 'completed' ? 'bg-green-50 dark:bg-green-900/20' : ''}"
							>
								<div class="mt-0.5">
									<Icon
										name={getStatusIcon(todo.status)}
										class="w-4 h-4 {getStatusColor(todo.status)} {todo.status === 'in_progress' && appState.isLoading ? 'animate-spin' : ''}"
									/>
								</div>
								<div class="flex-1 min-w-0">
									<p class="text-sm {todo.status === 'completed' ? 'line-through text-slate-500 dark:text-slate-400' : 'text-slate-900 dark:text-slate-100'}">
										{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}
									</p>
									<!-- {#if todo.status === 'in_progress'}
										<p class="text-xs text-violet-600 dark:text-violet-400 mt-0.5">In progress...</p>
									{:else if todo.status === 'completed'}
										<p class="text-xs text-green-600 dark:text-green-400 mt-0.5">Completed</p>
									{/if} -->
								</div>
								<span class="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
									{index + 1}/{latestTodos.length}
								</span>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</div>
	{/if}
{/if}

<style>
	/* Custom scrollbar for todo list */
	:global(.dark) div::-webkit-scrollbar {
		width: 6px;
	}

	div::-webkit-scrollbar {
		width: 6px;
	}

	div::-webkit-scrollbar-track {
		background: transparent;
	}

	div::-webkit-scrollbar-thumb {
		background: rgb(203 213 225);
		border-radius: 3px;
	}

	:global(.dark) div::-webkit-scrollbar-thumb {
		background: rgb(51 65 85);
	}

	div::-webkit-scrollbar-thumb:hover {
		background: rgb(148 163 184);
	}

	:global(.dark) div::-webkit-scrollbar-thumb:hover {
		background: rgb(71 85 105);
	}
</style>