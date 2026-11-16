<script lang="ts">
	/**
	 * One repeating task (stored as a flow): when it starts and its plan on a
	 * canvas (marked with how the last run went), what it learned, its runs
	 * with cost, and its versions. Clopen changes it as it runs — repairs a failing step, adds a lesson, turns a step that
	 * always answers the same into a script — and every change is a version the
	 * owner can go back to. Editing is the same recipe text Clopen writes;
	 * asking Clopen in the chat gives the same result.
	 */
	import { onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import PlanCanvas from './PlanCanvas.svelte';
	import Markdown from '$frontend/components/common/display/Markdown.svelte';
	import { assistantStore, type FlowView } from '$frontend/stores/features/assistant.svelte';
	import { openFlow } from '$frontend/stores/ui/assistant-view.svelte';
	import { projectState } from '$frontend/stores/core/projects.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { showConfirm } from '$frontend/stores/ui/dialog.svelte';
	import { isAssistantProject } from '$shared/utils/assistant-project';
	import type { JobDelivery, JobRun } from '$shared/types/assistant';
	import type { Recipe } from '$shared/types/recipe';
	import { relativeTime } from './format';
	import { DELIVERY_LABEL, duration, entriesAt, findStep, money, stepLabel, triggerIcon } from './recipe-format';
	import StepDetail from './StepDetail.svelte';

	interface Props {
		/** Null: a new repeating task. */
		flowId: string | null;
		mobile?: boolean;
		onBack?: () => void;
	}

	const { flowId, mobile = false, onBack }: Props = $props();
	let view = $state<'plan' | 'history' | 'versions'>('plan');
	let selected = $state<string | null>(null);

	type Version = { version: number; note: string; created_by: string; created_at: string; recipe: Recipe | null };

	let flow = $state<FlowView | null>(null);
	let runs = $state<JobRun[]>([]);
	let versions = $state<Version[]>([]);
	let editing = $state(false);
	let openRun = $state<string | null>(null);
	let busy = $state(false);
	let previewVersion = $state<number | null>(null);

	// ── Form ──
	let name = $state('');
	let when = $state('');
	let watchUrl = $state('');
	let recipe = $state('');
	let projectId = $state('');
	let delivery = $state<JobDelivery>('changes');
	let budget = $state('');
	let check = $state<{ ok: boolean; error?: string; when?: string; steps?: number } | null>(null);

	const EXAMPLE = '1. Do: check https://example.com is up → $status\n2. If: the site is down\n   1. Tell: The site is down — $status';
	const projects = $derived(projectState.projects.filter((project) => !isAssistantProject(project)));
	const lastRun = $derived(runs[0] ?? null);
	/** The selected step and every run of it in the last run. */
	const picked = $derived.by(() => {
		if (!selected || !flow) return null;
		const step = findStep(flow.recipe.steps, selected);
		const entries = lastRun ? entriesAt(lastRun.trace, selected) : [];
		return { step, entries, title: entries[entries.length - 1]?.label ?? (step ? stepLabel(step) : 'Step') };
	});
	let detailExpanded = $state(false);

	// ── Webhook: a secret URL that runs this task ──
	let hookOpen = $state(false);
	let hookUrl = $state<string | null>(null);

	async function loadHook(regenerate = false) {
		if (!flow) return;
		const result = (await ws.http('assistant:flow-hook', { id: flow.id, ...(regenerate ? { regenerate: true } : {}) })) as { path: string; publicOrigin: string | null };
		hookUrl = `${result.publicOrigin ?? window.location.origin}${result.path}`;
	}

	function toggleHook() {
		hookOpen = !hookOpen;
		if (hookOpen && !hookUrl) void loadHook().catch((error) => addNotification({ type: 'error', title: 'Webhook', message: String(error) }));
	}

	async function copyHook() {
		if (!hookUrl) return;
		await navigator.clipboard.writeText(hookUrl).catch(() => {});
		addNotification({ type: 'success', title: 'Copied', message: 'Webhook URL' });
	}
	const running = $derived(runs.some((run) => run.status === 'running'));
	/** What the list already knows, until the full flow arrives. */
	const known = $derived(flow ?? (flowId ? assistantStore.flows.find((entry) => entry.id === flowId) ?? null : null));
	const previewed = $derived(versions.find((version) => version.version === (previewVersion ?? flow?.version)) ?? null);
	const spentToday = $derived(
		runs.filter((run) => new Date(run.startedAt).toDateString() === new Date().toDateString()).reduce((sum, run) => sum + (run.costUsd ?? 0), 0)
	);

	async function load(id: string) {
		const result = await assistantStore.getFlow(id);
		if (id !== flowId) return;
		flow = result?.flow ?? null;
		runs = result?.runs ?? [];
		versions = result?.versions ?? [];
	}

	onMount(() => {
		if (!flowId) {
			seed();
			editing = true;
			return;
		}
		const id = flowId;
		void load(id);
		return ws.on('assistant:changed', (data: { scope: string; id: string | null }) => {
			if (data.scope === 'automations' && (data.id === id || data.id === null)) void load(id);
		});
	});

	function seed() {
		name = flow?.name ?? '';
		when = '';
		watchUrl = flow?.trigger.type === 'watch' && flow.trigger.config.target.kind === 'url' ? flow.trigger.config.target.url : '';
		recipe = flow?.recipeText ?? '';
		projectId = flow?.projectId ?? '';
		delivery = flow?.delivery ?? 'changes';
		budget = flow?.budgetUsd != null ? String(flow.budgetUsd) : '';
		check = null;
	}

	// Check the recipe and the "when" as the owner types, after a short pause.
	$effect(() => {
		if (!editing) return;
		const text = recipe;
		const schedule = when;
		if (!text.trim()) {
			check = null;
			return;
		}
		const timer = setTimeout(async () => {
			check = await assistantStore.checkRecipe(text, schedule || undefined).catch((error) => ({ ok: false, error: String(error) }));
		}, 400);
		return () => clearTimeout(timer);
	});

	async function act(run: () => Promise<unknown>, done?: string) {
		busy = true;
		try {
			await run();
			if (done) addNotification({ type: 'success', title: done, message: flow?.name ?? name });
		} catch (error) {
			addNotification({ type: 'error', title: 'That did not work', message: error instanceof Error ? error.message : String(error) });
		} finally {
			busy = false;
		}
	}

	async function save() {
		await act(async () => {
			const saved = await assistantStore.saveFlow({
				...(flow ? { id: flow.id } : {}),
				name: name.trim(),
				recipe,
				...(when.trim() ? { when: when.trim() } : {}),
				...(watchUrl.trim() && !when.trim() ? { watchUrl: watchUrl.trim() } : {}),
				projectId: projectId || null,
				delivery,
				budgetUsd: budget.trim() ? Number(budget) : null
			});
			editing = false;
			if (!flow) openFlow(saved.id);
			else await load(flow.id);
		}, 'Saved');
	}

	async function remove() {
		if (!flow) return;
		const confirmed = await showConfirm({ title: 'Delete this flow?', message: 'Its runs and versions go too.', confirmText: 'Delete', type: 'warning' });
		if (!confirmed) return;
		await act(async () => {
			await assistantStore.deleteFlow(flow!.id);
			openFlow(null);
		});
	}

	const heading = 'text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5';
	const input = 'w-full px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm outline-none focus:border-violet-500/60';
	const ghost = 'px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-700 bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer disabled:opacity-50';
	const primary = 'px-2.5 py-1.5 rounded-lg text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white border-none cursor-pointer disabled:opacity-50';
	const RUN_TONE: Record<JobRun['status'], string> = {
		running: 'bg-sky-500 animate-pulse',
		succeeded: 'bg-emerald-500',
		failed: 'bg-red-500',
		skipped: 'bg-slate-400'
	};
</script>

<div class="relative flex flex-col h-full min-h-0">
	<header class="flex items-start gap-2 py-3 px-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
		{#if onBack}
			<button type="button" class="flex items-center justify-center w-8 h-8 -ml-1 rounded-lg text-slate-500 hover:bg-violet-500/10 border-none bg-transparent cursor-pointer" onclick={onBack} aria-label="Back">
				<Icon name="lucide:arrow-left" class="w-4 h-4" />
			</button>
		{/if}
		<div class="flex-1 min-w-0">
			{#if known}
				<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">{known.name}</h2>
				<div class="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 min-w-0">
					<Icon name={triggerIcon(known.trigger.type)} class="w-3.5 h-3.5 shrink-0" />
					<span class="truncate">{known.when}</span>
					{#if known.enabled && known.nextRunAt}<span class="shrink-0">· next {relativeTime(known.nextRunAt)}</span>{/if}
					<span class="shrink-0">· v{known.version}</span>
				</div>
			{:else if flowId}
				<div class="h-5 w-48 rounded bg-slate-200/70 dark:bg-slate-800 animate-pulse"></div>
				<div class="mt-1.5 h-3 w-32 rounded bg-slate-200/50 dark:bg-slate-800/70 animate-pulse"></div>
			{:else}
				<h2 class="text-base font-semibold text-slate-900 dark:text-slate-100 truncate">New repeating task</h2>
			{/if}
		</div>
		{#if flow && !editing}
			<div class="flex items-center gap-1.5 shrink-0">
				{#if running}
					<button type="button" class={ghost} disabled={busy} onclick={() => act(() => assistantStore.stopFlow(flow!.id), 'Stopped')}>Stop</button>
				{:else}
					<button type="button" class={primary} disabled={busy} onclick={() => act(() => assistantStore.runFlow(flow!.id), 'Started')}>Run now</button>
				{/if}
				<button type="button" class={ghost} disabled={busy} onclick={() => act(() => assistantStore.toggleFlow(flow!.id, !flow!.enabled))}>{flow.enabled ? 'Turn off' : 'Turn on'}</button>
				<button type="button" class={ghost} onclick={() => { seed(); editing = true; }}>Edit</button>
				<button
					type="button"
					class="flex items-center justify-center w-8 h-8 rounded-lg bg-transparent border-none cursor-pointer {hookOpen ? 'text-violet-600 bg-violet-500/10' : 'text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'}"
					onclick={toggleHook}
					aria-label="Webhook"
					title="Webhook"
				><Icon name="lucide:webhook" class="w-4 h-4" /></button>
				<button type="button" class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-red-500 bg-transparent border-none cursor-pointer" onclick={remove} aria-label="Delete">
					<Icon name="lucide:trash-2" class="w-4 h-4" />
				</button>
			</div>
		{/if}
	</header>

	{#if hookOpen && flow && !editing}
		<!-- Run this task from anywhere that can send a request: a phone shortcut, n8n, a CI job. -->
		<div class="flex flex-col gap-1.5 px-4 py-3 border-b border-slate-200 dark:border-slate-800 shrink-0" transition:slide={{ duration: 180 }}>
			<p class="text-xs text-slate-500">POST to this URL to run it now. What you send becomes its context.</p>
			<div class="flex items-center gap-1.5">
				<code class="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 text-xs text-slate-700 dark:text-slate-200">{hookUrl ?? '…'}</code>
				<button type="button" class={ghost} disabled={!hookUrl} onclick={copyHook}>Copy</button>
				<button type="button" class={ghost} disabled={busy} onclick={() => loadHook(true)} title="Make a new URL; the old one stops working">New URL</button>
			</div>
		</div>
	{/if}

	{#if editing}
		<div class="flex-1 overflow-y-auto p-4">
			<form class="space-y-4" onsubmit={(event) => { event.preventDefault(); void save(); }}>
				<label class="block">
					<span class={heading}>Name</span>
					<input class={input} bind:value={name} placeholder="Morning check" required />
				</label>
				<div class="grid gap-3 sm:grid-cols-2">
					<label class="block">
						<span class={heading}>When</span>
						<input class={input} bind:value={when} placeholder={flow ? flow.when : 'every weekday at 9am · in 2 hours · only when I run it'} />
						{#if check?.when}<span class="mt-1 block text-2xs text-emerald-600 dark:text-emerald-400">{check.when}</span>{/if}
					</label>
					<label class="block">
						<span class={heading}>Or when this page changes</span>
						<input class={input} bind:value={watchUrl} placeholder="https://…" disabled={Boolean(when.trim())} />
					</label>
				</div>
				<label class="block">
					<span class={heading}>Steps</span>
					<textarea class="{input} font-mono text-xs leading-relaxed min-h-56" bind:value={recipe} placeholder={EXAMPLE} spellcheck="false"></textarea>
					{#if check}
						<span class="mt-1 block text-2xs {check.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}">
							{check.ok ? `${check.steps} steps` : check.error}
						</span>
					{/if}
					<span class="mt-1 block text-2xs text-slate-500">Verbs: Do, Run, HTTP, Use, Tell, Ask, Approve, If / Else, Choose / Case, For each, In parallel, Repeat until, Review, Flow, Wait. Save a result with → $name.</span>
				</label>
				<div class="grid gap-3 sm:grid-cols-3">
					<label class="block">
						<span class={heading}>Project</span>
						<select class={input} bind:value={projectId}>
							<option value="">Clopen</option>
							{#each projects as project (project.id)}<option value={project.id}>{project.name}</option>{/each}
						</select>
					</label>
					<label class="block">
						<span class={heading}>Tell me</span>
						<select class={input} bind:value={delivery}>
							{#each Object.entries(DELIVERY_LABEL) as [value, label] (value)}<option {value}>{label}</option>{/each}
						</select>
					</label>
					<label class="block">
						<span class={heading}>Daily budget (USD)</span>
						<input class={input} bind:value={budget} inputmode="decimal" placeholder="No limit" />
					</label>
				</div>
				<div class="flex justify-end gap-2">
					<button type="button" class={ghost} onclick={() => (flow ? (editing = false) : openFlow(null))}>Cancel</button>
					<button type="submit" class={primary} disabled={busy || !name.trim() || !recipe.trim() || check?.ok === false}>Save</button>
				</div>
			</form>
		</div>
	{:else if !flow}
		<div class="flex-1 min-h-0 p-6 flex flex-wrap content-start gap-6" aria-busy="true">
			{#each [0, 1, 2, 3] as index (index)}
				<div class="w-56 h-[78px] rounded-xl bg-slate-200/60 dark:bg-slate-800/60 animate-pulse"></div>
			{/each}
		</div>
	{:else}
		<nav class="flex items-center gap-1 px-4 pt-2 shrink-0" aria-label="Views">
			{#each [{ id: 'plan', label: 'Plan' }, { id: 'history', label: `History${runs.length ? ` (${runs.length})` : ''}` }, { id: 'versions', label: `Versions (${versions.length})` }] as tab (tab.id)}
				<button
					type="button"
					class="px-2.5 py-1 rounded-md text-xs font-medium border-none cursor-pointer {view === tab.id ? 'bg-violet-500/10 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300' : 'bg-transparent text-slate-500 hover:text-slate-900 dark:hover:text-slate-100'}"
					onclick={() => (view = tab.id as typeof view)}
				>{tab.label}</button>
			{/each}
			<span class="ml-auto text-2xs text-slate-400 truncate">{DELIVERY_LABEL[flow.delivery]}{flow.budgetUsd != null ? ` · ${money(spentToday)} of ${money(flow.budgetUsd)} today` : spentToday > 0 ? ` · ${money(spentToday)} today` : ''}</span>
		</nav>

		{#if view === 'plan'}
			<div class="flex-1 min-h-0 relative">
				<PlanCanvas recipe={flow.recipe} trace={lastRun?.trace ?? []} runningSteps={lastRun?.runningSteps ?? []} trigger={flow.when} {running} ended={Boolean(lastRun) && !running} vertical={mobile} {selected} onSelect={(path) => (selected = path)} />
			</div>
			{#if selected && picked}
				<StepDetail
					title={picked.title}
					step={picked.step}
					entries={picked.entries}
					expanded={detailExpanded}
					onToggleExpand={() => (detailExpanded = !detailExpanded)}
					onClose={() => {
						selected = null;
						detailExpanded = false;
					}}
				/>
			{:else if flow.notes.length}
				<section class="shrink-0 max-h-32 overflow-y-auto border-t border-slate-200 dark:border-slate-800 px-4 py-2">
					<h3 class={heading}>Learned</h3>
					<ul class="space-y-1">
						{#each flow.notes as note, index (index)}
							<li class="flex items-start gap-2 text-xs text-slate-700 dark:text-slate-300">
								<Icon name="lucide:sparkles" class="w-3.5 h-3.5 shrink-0 text-violet-500" />{note}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		{:else if view === 'history'}
			<div class="flex-1 min-h-0 overflow-y-auto p-4">
				{#if runs.length === 0}
					<p class="text-sm text-slate-500">Not run yet.</p>
				{:else}
					<ul class="space-y-1">
						{#each runs as run (run.id)}
							<li class="rounded-lg border border-slate-200 dark:border-slate-800">
								<button type="button" class="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm bg-transparent border-none cursor-pointer" onclick={() => (openRun = openRun === run.id ? null : run.id)}>
									<span class="w-2 h-2 rounded-full shrink-0 {RUN_TONE[run.status]}"></span>
									<span class="flex-1 min-w-0 truncate text-slate-700 dark:text-slate-300">{run.error ?? (run.output || run.status)}</span>
									{#if run.costUsd > 0}<span class="text-2xs text-slate-400 shrink-0">{money(run.costUsd)}</span>{/if}
									<span class="text-2xs text-slate-400 shrink-0" title={new Date(run.startedAt).toLocaleString()}>{relativeTime(run.startedAt)}</span>
								</button>
								{#if openRun === run.id}
									<ol class="px-3 pb-2 space-y-1">
										{#each run.trace as entry, index (index)}
											<li class="text-xs" style="padding-left: {(entry.path.split('.').length - 1) * 12}px">
												<span class={entry.status === 'failed' ? 'text-red-600 dark:text-red-400' : entry.status === 'skipped' ? 'text-slate-400' : 'text-slate-700 dark:text-slate-300'}>{entry.label}</span>
												<span class="text-slate-400"> · {duration(entry.ms)}{entry.costUsd ? ` · ${money(entry.costUsd)}` : ''}</span>
												{#if entry.error}<p class="text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{entry.error}</p>{/if}
												{#if entry.output}<p class="text-slate-500 whitespace-pre-wrap break-words line-clamp-4">{entry.output}</p>{/if}
											</li>
										{:else}
											<li class="text-xs text-slate-500 whitespace-pre-wrap break-words">{run.output || run.reason}</li>
										{/each}
									</ol>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{:else}
			<div class="flex-1 min-h-0 flex {mobile ? 'flex-col' : ''}">
				<ul class="{mobile ? 'max-h-48 border-b' : 'w-64 border-r'} shrink-0 overflow-y-auto p-2 space-y-0.5 border-slate-200 dark:border-slate-800">
					{#each versions as version (version.version)}
						{@const current = version.version === flow.version}
						<li>
							<button
								type="button"
								class="w-full flex flex-col gap-0.5 px-2.5 py-2 rounded-lg text-left border-none cursor-pointer {previewed?.version === version.version ? 'bg-violet-500/10 dark:bg-violet-500/20' : 'bg-transparent hover:bg-slate-100 dark:hover:bg-slate-800/60'}"
								onclick={() => (previewVersion = version.version)}
							>
								<span class="flex items-center gap-1.5 text-2xs text-slate-400">
									<span class="font-mono">v{version.version}</span>
									{#if current}<span class="px-1.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">Current</span>{/if}
									<span class="ml-auto">{version.created_by === 'user' ? 'You' : 'Clopen'} · {relativeTime(version.created_at)}</span>
								</span>
								<span class="text-sm text-slate-700 dark:text-slate-300 line-clamp-2">{version.note}</span>
							</button>
						</li>
					{/each}
				</ul>
				<div class="flex-1 min-w-0 min-h-0 flex flex-col">
					{#if previewed}
						<div class="flex items-center gap-2 px-4 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
							<span class="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-300 truncate">v{previewed.version} · {previewed.note}</span>
							{#if previewed.version !== flow.version}
								<button type="button" class={primary} disabled={busy} onclick={() => act(async () => { await assistantStore.revertFlow(flow!.id, previewed.version); previewVersion = null; }, 'Restored')}>Use this version</button>
							{/if}
						</div>
						<div class="flex-1 min-h-0 relative">
							{#if previewed.recipe}
								{#key previewed.version}
									<PlanCanvas recipe={previewed.recipe} trace={[]} trigger={flow.when} vertical={mobile} />
								{/key}
							{/if}
						</div>
					{/if}
				</div>
			</div>
		{/if}
	{/if}
</div>
