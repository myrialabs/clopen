<script lang="ts">
	/**
	 * Every task in one list — the ones under way, the ones that repeat, and
	 * the ones that ended. To the owner a repeating task is just a task that
	 * runs again; that it is stored as a flow is not their concern.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { assistantView, newFlow, openFlow, openTask } from '$frontend/stores/ui/assistant-view.svelte';
	import type { Mission } from '$shared/types/assistant';
	import { relativeTime, taskStatusLabel, taskStatusTone } from './format';
	import { triggerIcon } from './recipe-format';

	onMount(() => {
		void assistantStore.loadTasks();
		void assistantStore.loadFlows();
	});

	const tasks = $derived(assistantStore.tasks);
	const working = $derived(tasks.filter((task) => ['active', 'paused', 'stalled'].includes(task.status)));
	const ended = $derived(tasks.filter((task) => !['active', 'paused', 'stalled'].includes(task.status)).slice(0, 30));
	const repeating = $derived(assistantStore.flows);
	const loaded = $derived(assistantStore.loaded.tasks && assistantStore.loaded.flows);

	const isSelected = (type: 'task' | 'repeat', id: string) => assistantView.selected?.type === type && assistantView.selected.id === id;
	const busy = (task: Mission) => task.sessions.some((session) => session.busy);
	function line(task: Mission): string {
		const roles = task.sessions.filter((session) => session.busy).map((session) => session.role ?? 'Agent');
		return roles.length ? roles.join(', ') : taskStatusLabel(task.status, busy(task));
	}

	const row = 'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left border-none cursor-pointer transition-colors';
	const heading = 'px-2.5 mt-3 mb-1 text-2xs font-semibold uppercase tracking-wider text-slate-400';
</script>

<div class="flex flex-col min-h-0 h-full">
	<div class="flex items-center justify-between px-1 pb-2">
		<h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Tasks</h2>
		<button type="button" class="flex items-center gap-1 px-2 py-1 rounded-md text-xs text-violet-600 dark:text-violet-400 bg-transparent border-none cursor-pointer hover:bg-violet-500/10" onclick={newFlow} title="A task that repeats">
			<Icon name="lucide:plus" class="w-3.5 h-3.5" /> Repeating
		</button>
	</div>

	<div class="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
		{#if !loaded}
			<div class="flex items-center gap-2 p-3 text-sm text-slate-500"><Icon name="lucide:loader" class="w-4 h-4 animate-spin" /> Loading…</div>
		{:else if !tasks.length && !repeating.length}
			<div class="flex flex-col items-center text-center gap-2 py-12 px-4">
				<Icon name="lucide:list-checks" class="w-6 h-6 text-violet-500" />
				<p class="text-sm font-medium text-slate-700 dark:text-slate-200">No tasks yet</p>
				<p class="text-xs text-slate-500 dark:text-slate-400">Ask Clopen in the chat.</p>
			</div>
		{:else}
			{#if working.length}
				<h3 class={heading}>Working</h3>
				{#each working as task (task.id)}
					<button type="button" class="{row} {isSelected('task', task.id) ? 'bg-violet-500/10 dark:bg-violet-500/20' : 'bg-transparent hover:bg-violet-500/5'}" onclick={() => openTask(task.id)}>
						<span class="mt-1.5 w-2 h-2 rounded-full shrink-0 {taskStatusTone(task.status, busy(task))}"></span>
						<span class="flex-1 min-w-0">
							<span class="block text-sm font-medium text-slate-900 dark:text-slate-100 truncate">{task.title}</span>
							<span class="block text-xs text-slate-500 dark:text-slate-400 truncate">Once · {line(task)}</span>
						</span>
					</button>
				{/each}
			{/if}

			{#if repeating.length}
				<h3 class={heading}>Repeating</h3>
				{#each repeating as flow (flow.id)}
					<button type="button" class="{row} {isSelected('repeat', flow.id) ? 'bg-violet-500/10 dark:bg-violet-500/20' : 'bg-transparent hover:bg-violet-500/5'}" onclick={() => openFlow(flow.id)}>
						<Icon name={triggerIcon(flow.trigger.type)} class="w-4 h-4 mt-0.5 shrink-0 {flow.enabled ? 'text-violet-500' : 'text-slate-300 dark:text-slate-600'}" />
						<span class="flex-1 min-w-0">
							<span class="block text-sm font-medium truncate {flow.enabled ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400'}">{flow.name}</span>
							<span class="block text-xs text-slate-500 dark:text-slate-400 truncate">
								{flow.enabled ? (flow.nextRunAt ? `${flow.when} · next ${relativeTime(flow.nextRunAt)}` : flow.when) : 'Off'}
							</span>
						</span>
					</button>
				{/each}
			{/if}

			{#if ended.length}
				<h3 class={heading}>Ended</h3>
				{#each ended as task (task.id)}
					<button type="button" class="{row} {isSelected('task', task.id) ? 'bg-violet-500/10 dark:bg-violet-500/20' : 'bg-transparent hover:bg-violet-500/5'}" onclick={() => openTask(task.id)}>
						<span class="mt-1.5 w-2 h-2 rounded-full shrink-0 {taskStatusTone(task.status, false)}"></span>
						<span class="flex-1 min-w-0">
							<span class="block text-sm text-slate-700 dark:text-slate-300 truncate">{task.title}</span>
							<span class="block text-xs text-slate-500 dark:text-slate-400 truncate">{taskStatusLabel(task.status, false)} · {relativeTime(task.updatedAt)}</span>
						</span>
					</button>
				{/each}
			{/if}
		{/if}
	</div>
</div>
