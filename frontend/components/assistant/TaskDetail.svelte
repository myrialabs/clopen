<script lang="ts">
	/**
	 * One task: how it ended (or how far it is), and its plan on a canvas —
	 * who does what, in which order, and how each step went. A step opens what
	 * it produced and that agent's chat in its project. The header comes from
	 * the list at once; only the plan waits for the full task.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import PlanCanvas from './PlanCanvas.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import { assistantStore } from '$frontend/stores/features/assistant.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { openSession } from '$frontend/services/navigation/session-deep-link';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import type { Mission } from '$shared/types/assistant';
	import { relativeTime, taskStatusLabel, taskStatusTone } from './format';
	import { entriesAt, findStep, money } from './recipe-format';
	import StepDetail from './StepDetail.svelte';

	interface Props {
		taskId: string;
		mobile?: boolean;
		onBack?: () => void;
	}

	const { taskId, mobile = false, onBack }: Props = $props();

	let task = $state<Mission | null>(null);
	let loading = $state(false);
	let busyAction = $state(false);
	let selected = $state<string | null>(null);

	async function load(id: string) {
		loading = true;
		const result = await assistantStore.getTask(id);
		if (id !== taskId) return;
		task = result?.mission ?? null;
		loading = false;
	}

	$effect(() => {
		const id = taskId;
		selected = null;
		void load(id);
		return ws.on('assistant:changed', (data: { scope: string; id: string | null }) => {
			if (data.scope === 'tasks' && (data.id === id || data.id === null)) void load(id);
		});
	});

	/** What the list already knows, until the full task arrives. */
	const known = $derived(task ?? assistantStore.tasks.find((entry) => entry.id === taskId) ?? assistantStore.overview?.activeMissions.find((entry) => entry.id === taskId) ?? null);
	const busy = $derived(Boolean(known?.sessions.some((session) => session.busy)));
	const running = $derived(task?.status === 'active');
	const spent = $derived(task ? task.trace.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0) : 0);
	const projectId = $derived(known?.sessions[0]?.projectId ?? null);
	const projectName = $derived(projectState.projects.find((project) => project.id === projectId)?.name ?? null);

	/** The step behind the selected card, every run of it, and the agent chat that did it. */
	const detail = $derived.by(() => {
		if (!task?.recipe || !selected) return null;
		const step = findStep(task.recipe.steps, selected);
		const entries = entriesAt(task.trace, selected);
		const role = step && step.kind === 'do' ? (step.role ?? null) : null;
		const session = role ? task.sessions.find((entry) => (entry.role ?? '').toLowerCase() === role.toLowerCase()) : null;
		return { step, entries, session };
	});
	let detailExpanded = $state(false);

	async function setStatus(status: 'active' | 'paused' | 'cancelled') {
		if (!task) return;
		if (status === 'cancelled') {
			const confirmed = await showConfirm({ title: 'Cancel this task?', message: 'Work already done stays.', confirmText: 'Cancel task', type: 'warning' });
			if (!confirmed) return;
		}
		busyAction = true;
		try {
			await assistantStore.setTaskStatus(task.id, status);
		} finally {
			busyAction = false;
		}
	}

	const button = 'px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer disabled:opacity-50';
</script>

<div class="relative flex flex-col h-full min-h-0">
	<header class="flex {mobile ? 'flex-wrap' : ''} items-start gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if onBack}
			<button type="button" class="flex items-center justify-center w-8 h-8 -ml-1 rounded-lg text-slate-500 hover:bg-violet-500/10 border-none bg-transparent cursor-pointer" onclick={onBack} aria-label="Back">
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
		{/if}
		<div class="flex-1 min-w-0">
			{#if known}
				<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 {mobile ? 'line-clamp-2' : 'truncate'}">{known.title}</h2>
				<div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
					<span class="flex items-center gap-1.5"><span class="w-2 h-2 rounded-full {taskStatusTone(known.status, busy)}"></span>{taskStatusLabel(known.status, busy)}</span>
					{#if projectName}<span>· {projectName}</span>{/if}
					{#if spent > 0}<span>· {money(spent)}</span>{/if}
					<span>· {relativeTime(known.updatedAt)}</span>
				</div>
			{:else}
				<div class="h-5 w-48 rounded bg-slate-200/70 dark:bg-slate-800 animate-pulse"></div>
				<div class="mt-1.5 h-3 w-32 rounded bg-slate-200/50 dark:bg-slate-800/70 animate-pulse"></div>
			{/if}
		</div>
		{#if task && ['active', 'paused', 'stalled'].includes(task.status)}
			<!-- On a phone the buttons take their own row under the title. -->
			<div class="flex items-center gap-1.5 shrink-0 {mobile ? 'w-full pl-9' : ''}">
				{#if task.status === 'active'}
					<button type="button" disabled={busyAction} class="{button} border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800" onclick={() => setStatus('paused')}>Pause</button>
				{:else}
					<button type="button" disabled={busyAction} class="{button} border-transparent bg-violet-600 hover:bg-violet-700 text-white" onclick={() => setStatus('active')}>{task.status === 'stalled' ? 'Keep going' : 'Resume'}</button>
				{/if}
				<button type="button" disabled={busyAction} class="{button} border-red-200 dark:border-red-900/60 bg-transparent text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30" onclick={() => setStatus('cancelled')}>Cancel</button>
			</div>
		{/if}
	</header>

	{#if loading && !task}
		<div class="flex-1 min-h-0 p-6 flex flex-wrap content-start gap-6" aria-busy="true">
			{#each [0, 1, 2, 3] as index (index)}
				<div class="w-56 h-[78px] rounded-xl bg-slate-200/60 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else if !task}
		<p class="p-4 text-sm text-slate-500">This task no longer exists.</p>
	{:else}
		{#if task.summary}
			<p class="mx-4 mt-3 shrink-0 text-sm whitespace-pre-wrap break-words p-3 rounded-lg border {task.status === 'completed' ? 'bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200/60 dark:border-emerald-500/20 text-slate-700 dark:text-slate-200' : 'bg-amber-50 dark:bg-amber-500/10 border-amber-200/60 dark:border-amber-500/20 text-slate-700 dark:text-slate-200'}">{task.summary}</p>
		{/if}

		{#if task.recipe}
			<div class="flex-1 min-h-0 relative">
				<PlanCanvas recipe={task.recipe} trace={task.trace} runningSteps={task.runningSteps} running={running} ended={!["active", "paused"].includes(task.status)} vertical={mobile} {selected} onSelect={(path) => (selected = path)} />
			</div>
		{:else}
			<div class="flex-1 min-h-0 overflow-y-auto p-4 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{task.goal}</div>
		{/if}

		{#if detail}
			<StepDetail
				title={`${detail.step?.kind === 'do' && detail.step.role ? `${detail.step.role} · ` : ''}${detail.step?.title ?? ''}`}
				step={detail.step}
				entries={detail.entries}
				{projectName}
				onOpenChat={detail.session ? () => openSession(detail.session!.projectId, detail.session!.sessionId) : null}
				expanded={detailExpanded}
				onToggleExpand={() => (detailExpanded = !detailExpanded)}
				onClose={() => {
					selected = null;
					detailExpanded = false;
				}}
			/>
		{/if}
	{/if}
</div>
