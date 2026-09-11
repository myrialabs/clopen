<script lang="ts">
	/**
	 * CI runs for the branch behind a pull request.
	 *
	 * Shaped like the Commits tab — list on the left, the selected run on the
	 * right — for the same reason: a column of statuses beside an empty half of
	 * the pane answers "did it pass" and nothing else, and the question that
	 * actually brings anyone here is "why did it fail". So the failure is on
	 * screen: the run's logs are read inline, in the same budgeted form the chat
	 * prompt is built from, rather than behind a modal on top of a modal.
	 *
	 * The newest run opens on arrival, because it is the one that matters.
	 *
	 * This is now the ONLY place checks live. There was a second copy in the
	 * list column, showing the runs for whatever branch the workspace happened
	 * to be on — the same panel answering a different question in the same
	 * words, one click apart from this one.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import RefreshButton from './RefreshButton.svelte';
	import { workStore } from '$frontend/stores/features/work.svelte';
	import { copyText } from '$frontend/utils/clipboard';
	import { showInfo } from '$frontend/stores/ui/notification.svelte';
	import type { CheckRun } from '$shared/types/work';
	import type { IconName } from '$shared/types/ui/icons';

	const runs = $derived(workStore.checks);
	const branch = $derived(workStore.checksBranch);
	const sendingRunId = $derived(workStore.sendingRunId);

	let selectedId = $state<string | null>(null);
	const active = $derived(runs.find((run) => run.id === selectedId) ?? runs[0] ?? null);

	let logs = $state<{ text: string; truncated: boolean } | null>(null);
	let loadingLogs = $state(false);
	/**
	 * The run object whose logs are held, compared by IDENTITY.
	 *
	 * By id, a refresh would find the same id and keep the logs it already had,
	 * which for a run still in progress is the wrong half of the output. The
	 * store hands out new objects only when it has re-read the runs, so the
	 * reference is exactly "these logs are for a version of this run we no
	 * longer hold".
	 */
	let loadedFor = $state<CheckRun | null>(null);

	// Logs are fetched for the open run, and only when the provider says there
	// are any: a passing run's logs are mostly dependency installation.
	$effect(() => {
		const run = active;
		if (!run || !run.canFetchLogs) {
			logs = null;
			loadedFor = null;
			loadingLogs = false;
			return;
		}
		if (run === loadedFor) return;

		loadedFor = run;
		logs = null;
		loadingLogs = true;
		void workStore.fetchCheckLogs(run).then((bundle) => {
			// A slower answer for a run the user has moved off must not land in
			// the pane showing another one.
			if (loadedFor !== run) return;
			loadingLogs = false;
			logs = bundle ? { text: bundle.text, truncated: bundle.truncated } : null;
		});
	});

	function style(run: CheckRun): { icon: IconName; class: string; label: string } {
		switch (run.status) {
			case 'success':
				return { icon: 'lucide:circle-check', class: 'text-green-600 dark:text-green-400', label: 'Passed' };
			case 'failure':
				return { icon: 'lucide:circle-x', class: 'text-red-600 dark:text-red-400', label: 'Failed' };
			case 'running':
				return { icon: 'lucide:loader-circle', class: 'text-amber-500 animate-spin', label: 'Running' };
			case 'queued':
				return { icon: 'lucide:clock', class: 'text-slate-500', label: 'Queued' };
			case 'cancelled':
				return { icon: 'lucide:circle-slash', class: 'text-slate-500', label: 'Cancelled' };
			case 'skipped':
				return { icon: 'lucide:circle-slash', class: 'text-slate-400', label: 'Skipped' };
			default:
				return { icon: 'lucide:circle-question-mark', class: 'text-slate-400', label: 'Unknown' };
		}
	}

	/** `4m 12s`, or nothing when the provider left the timestamps out. */
	function duration(run: CheckRun): string {
		if (!run.startedAt) return '';
		const end = run.finishedAt ? new Date(run.finishedAt) : new Date();
		const seconds = Math.round((end.getTime() - new Date(run.startedAt).getTime()) / 1000);
		if (!Number.isFinite(seconds) || seconds < 0) return '';
		if (seconds < 60) return `${seconds}s`;
		return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	}

	async function copyLogs() {
		if (!logs) return;
		const ok = await copyText(logs.text);
		showInfo(ok ? 'Copied' : 'Could not copy', ok ? 'Logs copied.' : 'The clipboard refused the request.');
	}
</script>

<div class="flex flex-col h-full min-h-0">
	<div class="flex items-center gap-2 px-3 py-1.5 shrink-0 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800/70">
		<Icon name="lucide:git-branch" class="w-3.5 h-3.5 shrink-0" />
		<span class="font-mono truncate text-slate-700 dark:text-slate-300">{branch || '—'}</span>
		<span class="flex-1"></span>
		<RefreshButton
			isLoading={workStore.isLoadingChecks}
			onRefresh={() => workStore.loadChecks(branch || undefined)}
			label="Refresh runs"
		/>
	</div>

	{#if workStore.isLoadingChecks && runs.length === 0}
		<div class="flex items-center justify-center flex-1">
			<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
		</div>
	{:else if runs.length === 0}
		<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 text-center">
			<Icon name="lucide:circle-check" class="w-8 h-8 text-slate-300 dark:text-slate-700" />
			<p class="text-sm text-slate-600 dark:text-slate-400 m-0">No runs for this branch</p>
			<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
				Push the branch, or check that the token can read Actions.
			</p>
		</div>
	{:else}
		<div class="flex flex-1 min-h-0">
			<aside class="hidden md:flex flex-col w-64 lg:w-72 shrink-0 border-r border-slate-200 dark:border-slate-800">
				<ul class="flex flex-col list-none flex-1 min-h-0 overflow-y-auto m-0 p-0">
					{#each runs as run (run.id)}
						{@const look = style(run)}
						<li>
							<button
								type="button"
								class="flex items-start gap-2 w-full px-3 py-2 text-left bg-transparent border-none border-b border-slate-100 dark:border-slate-800/70 cursor-pointer transition-colors duration-150
									{run.id === active?.id ? 'bg-violet-500/10' : 'hover:bg-violet-500/5'}"
								onclick={() => (selectedId = run.id)}
							>
								<Icon name={look.icon} class="w-4 h-4 mt-0.5 shrink-0 {look.class}" />
								<span class="flex flex-col min-w-0 flex-1">
									<span class="text-sm text-slate-900 dark:text-slate-100 leading-snug truncate">{run.name}</span>
									<span class="text-xs text-slate-500 dark:text-slate-500 truncate">
										{look.label} · {run.event} · {run.headSha.slice(0, 7)}
									</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			</aside>

			<div class="flex flex-col flex-1 min-w-0 min-h-0">
				<!-- The list, for screens with no room for the list. -->
				<div class="flex md:hidden items-center gap-2 px-3 py-1.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
					<Icon name="lucide:circle-check" class="w-3.5 h-3.5 shrink-0 text-slate-500" />
					<select
						class="flex-1 min-w-0 h-8 px-2 text-xs bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-md text-slate-900 dark:text-slate-100 focus:outline-none focus:border-violet-500"
						value={active?.id ?? ''}
						onchange={(event) => (selectedId = event.currentTarget.value)}
						aria-label="Pick a run"
					>
						{#each runs as run (run.id)}
							<option value={run.id}>{style(run).label} · {run.name}</option>
						{/each}
					</select>
				</div>

				{#if active}
					{@const look = style(active)}
					{@const ran = duration(active)}
					<header class="flex flex-col gap-1.5 px-4 py-2.5 shrink-0 border-b border-slate-200 dark:border-slate-800">
						<div class="flex items-start gap-2">
							<Icon name={look.icon} class="w-4 h-4 mt-0.5 shrink-0 {look.class}" />
							<h3 class="flex-1 m-0 text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
								{active.name}
							</h3>
							<a
								href={active.url}
								target="_blank"
								rel="noreferrer noopener"
								class="flex items-center justify-center w-6 h-6 shrink-0 rounded text-slate-500 no-underline hover:bg-violet-500/10 hover:text-slate-900 dark:hover:text-slate-100"
								title="Open the run on the web"
							>
								<Icon name="lucide:external-link" class="w-3 h-3" />
							</a>
						</div>

						<div class="flex items-center gap-2 flex-wrap text-xs text-slate-500 dark:text-slate-500">
							<span class={look.class}>{look.label}</span>
							<span>· {active.event}</span>
							<span class="font-mono">· {active.headSha.slice(0, 7)}</span>
							{#if active.startedAt}
								<span>· {new Date(active.startedAt).toLocaleString()}</span>
							{/if}
							{#if ran}<span>· took {ran}</span>{/if}
						</div>

						{#if active.canFetchLogs}
							<div class="flex items-center gap-1.5 flex-wrap">
								<button
									type="button"
									class="flex items-center gap-1 h-7 px-2 text-[0.7rem] font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60"
									disabled={sendingRunId !== null}
									onclick={() => workStore.sendCheckToChat(active)}
								>
									{#if sendingRunId === active.id}
										<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin" />
										Sending…
									{:else}
										<Icon name="lucide:message-square" class="w-3 h-3" />
										Send to chat
									{/if}
								</button>
								<button
									type="button"
									class="flex items-center gap-1 h-7 px-2 text-[0.7rem] font-medium rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer transition-colors duration-150 hover:border-violet-500/50 hover:text-violet-600 dark:hover:text-violet-400 disabled:opacity-60"
									disabled={!logs?.text}
									onclick={copyLogs}
								>
									<Icon name="lucide:copy" class="w-3 h-3" />
									Copy logs
								</button>
							</div>
						{/if}
					</header>

					<div class="flex flex-col flex-1 min-h-0 p-3">
						{#if !active.canFetchLogs}
							<div class="flex flex-col items-center justify-center gap-2 flex-1 px-6 text-center">
								<Icon name={look.icon} class="w-8 h-8 {look.class}" />
								<p class="text-sm text-slate-600 dark:text-slate-400 m-0">{look.label}</p>
								<p class="text-xs text-slate-500 dark:text-slate-500 m-0">
									This provider exposes no logs for a run in this state.
								</p>
							</div>
						{:else if loadingLogs}
							<div class="flex items-center justify-center flex-1">
								<Icon name="lucide:loader-circle" class="w-5 h-5 text-slate-400 animate-spin" />
							</div>
						{:else if !logs?.text}
							<p class="text-sm text-slate-500 dark:text-slate-500 m-0 py-8 text-center">
								No logs were returned. They may have expired — GitHub discards them
								after the repository's retention window.
							</p>
						{:else}
							{#if logs.truncated}
								<p class="flex items-start gap-2 shrink-0 mb-2 text-xs text-amber-700 dark:text-amber-400 m-0">
									<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5 mt-0.5 shrink-0" />
									Tails only — earlier output was dropped. A CI log's opening is
									dependency installation; the failure is at the end.
								</p>
							{/if}
							<!-- The same budgeted bundle the chat prompt is built from, so what
							     is read here is exactly what the agent would be given. -->
							<pre class="flex-1 min-h-0 m-0 p-3 overflow-auto text-xs leading-5 font-mono whitespace-pre-wrap break-words rounded-lg bg-slate-100 dark:bg-slate-900 text-slate-800 dark:text-slate-200">{logs.text}</pre>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>
