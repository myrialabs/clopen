<!--
  Floating Todo List Component
  Displays the latest TodoWrite content in a floating panel
  Updates when new TodoWrite messages arrive
  Session-aware to only show todos for current session
-->

<script lang="ts">
	import { sessionState } from '$frontend/stores/core/sessions.svelte';
	import { appState } from '$frontend/stores/core/app.svelte';
	import { todoPanelState, saveTodoPanelState } from '$frontend/stores/ui/todo-panel.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { fly } from 'svelte/transition';
	import type { TodoItem, TodoWriteInput } from '$shared/types/unified';

	// Drag-only local state (posX is always transient, posY syncs to store on drop)
	let posY = $state(todoPanelState.posY);
	let posX = $state(0);
	let isDragging = $state(false);

	// Minimized button ref for measuring width at snap time
	let minimizedBtn = $state<HTMLButtonElement | null>(null);

	// Non-reactive drag tracking
	let _sx = 0, _sy = 0, _mx = 0, _my = 0, _hasDragged = false;

	function getPanelWidth() {
		return todoPanelState.isExpanded ? 330 : 230;
	}

	// Always use `left` property so CSS can transition in both directions
	const panelDisplayLeft = $derived(
		isDragging ? posX : todoPanelState.snapSide === 'right' ? window.innerWidth - getPanelWidth() - 16 : 16
	);

	const minimizedDisplayLeft = $derived(
		isDragging
			? posX
			: todoPanelState.snapSide === 'right'
				? window.innerWidth - (minimizedBtn?.offsetWidth ?? 90) - 16
				: 16
	);

	// --- Main panel drag (from header) ---
	function startDrag(e: PointerEvent) {
		if ((e.target as HTMLElement).closest('button')) return;
		isDragging = true;
		// Use actual rendered position for accuracy
		const panel = (e.currentTarget as HTMLElement).parentElement!;
		const rect = panel.getBoundingClientRect();
		_sx = rect.left;
		_sy = rect.top;
		_mx = e.clientX;
		_my = e.clientY;
		posX = _sx;
		posY = _sy;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onDrag(e: PointerEvent) {
		if (!isDragging) return;
		posX = _sx + e.clientX - _mx;
		posY = Math.max(0, Math.min(window.innerHeight - 56, _sy + e.clientY - _my));
	}

	function endDrag(e: PointerEvent) {
		if (!isDragging) return;
		isDragging = false;
		todoPanelState.snapSide = posX + getPanelWidth() / 2 < window.innerWidth / 2 ? 'left' : 'right';
		todoPanelState.posY = posY;
		saveTodoPanelState();
	}

	// --- Minimized button drag (click = restore, drag = move) ---
	function startMinimizedDrag(e: PointerEvent) {
		isDragging = true;
		_hasDragged = false;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		_sx = rect.left;
		_sy = rect.top;
		_mx = e.clientX;
		_my = e.clientY;
		posX = _sx;
		posY = _sy;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onMinimizedDrag(e: PointerEvent) {
		if (!isDragging) return;
		const dx = e.clientX - _mx;
		const dy = e.clientY - _my;
		if (Math.abs(dx) > 5 || Math.abs(dy) > 5) _hasDragged = true;
		posX = _sx + dx;
		posY = Math.max(0, Math.min(window.innerHeight - 56, _sy + dy));
	}

	function endMinimizedDrag(e: PointerEvent) {
		if (!isDragging) return;
		isDragging = false;
		if (!_hasDragged) {
			restore();
			return;
		}
		const el = e.currentTarget as HTMLElement;
		todoPanelState.snapSide = posX + el.offsetWidth / 2 < window.innerWidth / 2 ? 'left' : 'right';
		todoPanelState.posY = posY;
		saveTodoPanelState();
	}

	// Extract the latest TodoWrite data from messages
	const latestTodos = $derived.by(() => {
		if (!sessionState.currentSession || sessionState.messages.length === 0) {
			return null;
		}

		// Search from newest to oldest for TodoWrite tool
		for (let i = sessionState.messages.length - 1; i >= 0; i--) {
			const message = sessionState.messages[i];

			if (message.type === 'assistant' && 'content' in message) {
				// Find TodoWrite tool_use in content
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

	// Calculate progress
	const progress = $derived.by(() => {
		if (!latestTodos) return { completed: 0, total: 0, percentage: 0 };

		const total = latestTodos.length;
		const completed = latestTodos.filter((t) => t.status === 'completed').length;
		const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

		return { completed, total, percentage };
	});

	// Only show if we have todos and not restoring
	const shouldShow = $derived(latestTodos !== null && latestTodos.length > 0);

	function toggleExpand() {
		if (!todoPanelState.isMinimized) {
			todoPanelState.isExpanded = !todoPanelState.isExpanded;
			saveTodoPanelState();
		}
	}

	function minimize() {
		todoPanelState.isMinimized = true;
		todoPanelState.isExpanded = false;
		saveTodoPanelState();
	}

	function restore() {
		todoPanelState.isMinimized = false;
		todoPanelState.isExpanded = true;
		saveTodoPanelState();
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
	{#if todoPanelState.isMinimized}
		<!-- Minimized state - small floating button, draggable -->
		<button
			bind:this={minimizedBtn}
			onpointerdown={startMinimizedDrag}
			onpointermove={onMinimizedDrag}
			onpointerup={endMinimizedDrag}
			onpointercancel={endMinimizedDrag}
			class="fixed z-30 bg-violet-600 hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-600 text-white rounded-full p-3 shadow-lg flex items-center gap-2"
			style="
				top: {posY}px;
				left: {minimizedDisplayLeft}px;
				touch-action: none;
				cursor: {isDragging ? 'grabbing' : 'grab'};
				transition: {isDragging ? 'none' : 'left 0.25s ease, top 0.15s ease'};
			"
			transition:fly={{ x: todoPanelState.snapSide === 'right' ? 100 : -100, duration: 200 }}
		>
			<Icon name="lucide:list-todo" class="w-5 h-5" />
			<span class="text-sm font-medium">{progress.completed}/{progress.total}</span>
		</button>
	{:else}
		<!-- Floating panel -->
		<div
			class="fixed z-30 bg-white dark:bg-slate-900 rounded-xl shadow-lg border border-slate-200 dark:border-slate-700 overflow-hidden"
			style="
				top: {posY}px;
				left: {panelDisplayLeft}px;
				width: {todoPanelState.isExpanded ? '330px' : '230px'};
				max-height: {todoPanelState.isExpanded ? '600px' : '56px'};
				transition: {isDragging ? 'none' : 'left 0.25s ease, top 0.15s ease, width 0.3s, max-height 0.3s'};
			"
			transition:fly={{ x: todoPanelState.snapSide === 'right' ? 100 : -100, duration: 300 }}
		>
			<!-- Header (drag handle) -->
			<div
				class="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-50 to-violet-50 dark:from-slate-800 dark:to-slate-800 border-b border-slate-200 dark:border-slate-700"
				style="touch-action: none; cursor: {isDragging ? 'grabbing' : 'grab'};"
				onpointerdown={startDrag}
				onpointermove={onDrag}
				onpointerup={endDrag}
				onpointercancel={endDrag}
				role="none"
			>
				<div class="flex items-center gap-3">
					<Icon name="lucide:list-todo" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
					<div class="flex flex-col">
						<span class="text-sm font-semibold text-slate-900 dark:text-slate-100">
							Task Progress
						</span>
						{#if !todoPanelState.isExpanded}
							<span class="text-xs text-slate-600 dark:text-slate-400">
								{progress.completed}/{progress.total} tasks ({progress.percentage}%)
							</span>
						{/if}
					</div>
				</div>

				<div class="flex items-center gap-1">
					<button
						onclick={toggleExpand}
						class="flex p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
						title={todoPanelState.isExpanded ? 'Collapse' : 'Expand'}
					>
						<Icon
							name={todoPanelState.isExpanded ? 'lucide:chevron-up' : 'lucide:chevron-down'}
							class="w-4 h-4 text-slate-600 dark:text-slate-400"
						/>
					</button>
					<button
						onclick={minimize}
						class="flex p-1.5 hover:bg-slate-100 dark:hover:bg-slate-700 rounded-lg transition-colors"
						title="Minimize"
					>
						<Icon name="lucide:minus" class="w-4 h-4 text-slate-600 dark:text-slate-400" />
					</button>
				</div>
			</div>

			{#if todoPanelState.isExpanded}
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
									{index + 1}/{latestTodos?.length}
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
