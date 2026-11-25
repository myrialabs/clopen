<script lang="ts">
	/**
	 * Settings → Storage — everything about the bytes Clopen keeps on this machine.
	 *
	 * One section, four tabs, so no question needs a long scroll: what is used
	 * (Overview), what can go now (Clean up, one group at a time), what each
	 * project holds (Projects) and what goes on its own (Schedule). Disk use per
	 * project folder lives here too, next to the data Clopen keeps for it.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { setActiveSection } from '$frontend/stores/ui/settings-modal.svelte';
	import {
		formatBytes, isSpent, loadProjectFolders, loadStorage, rescanStorage, runCleanup, storageStore, subscribeStorage
	} from '$frontend/stores/features/storage.svelte';
	import type { CleanupActionId } from '$shared/types/storage';
	import DataManagementSettings from '../general/DataManagementSettings.svelte';
	import CleanupActionRow from './CleanupActionRow.svelte';
	import StoragePolicyCard from './StoragePolicyCard.svelte';
	import StorageProjects from './StorageProjects.svelte';
	import { ACTION_COPY, CATEGORY_COPY, engineLabel, formatRelative } from './storage-copy';

	type Tab = 'overview' | 'cleanup' | 'projects' | 'schedule';
	type CleanupGroup = 'unused' | 'in-use' | 'chats' | 'everything';

	let tab = $state<Tab>('overview');
	let group = $state<CleanupGroup>('unused');
	let cleaningAll = $state(false);
	let showAllHistory = $state(false);

	onMount(() => {
		const off = subscribeStorage();
		void loadStorage();
		void loadProjectFolders();
		return off;
	});

	const report = $derived(storageStore.report);
	const status = $derived(storageStore.status);
	const categories = $derived(report ? [...report.categories].filter(c => c.bytes > 0).sort((a, b) => b.bytes - a.bytes) : []);
	const safeActions = $derived(storageStore.actions.filter(a => a.tier === 'safe' && !a.projectScoped));
	const cautionActions = $derived(storageStore.actions.filter(a => a.tier === 'caution' && !a.projectScoped));
	const safePending = $derived(
		report ? report.estimates.filter(e => safeActions.some(a => a.id === e.action) && e.items > 0 && !isSpent({ action: e.action })) : []
	);
	const safeReclaimable = $derived(safePending.reduce((total, e) => total + e.bytes, 0));
	const reclaimableTotal = $derived(categories.reduce((total, c) => total + c.reclaimableBytes, 0));
	const clopenPercent = $derived(report?.disk ? (report.totalBytes / report.disk.totalBytes) * 100 : 0);
	const history = $derived(showAllHistory ? storageStore.history : storageStore.history.slice(0, 4));

	const TABS: Array<{ id: Tab; label: string }> = [
		{ id: 'overview', label: 'Overview' },
		{ id: 'cleanup', label: 'Clean up' },
		{ id: 'projects', label: 'Projects' },
		{ id: 'schedule', label: 'Schedule' }
	];
	const GROUPS = $derived<Array<{ id: CleanupGroup; label: string; count: number }>>([
		{ id: 'unused', label: 'Unused', count: safePending.length },
		{ id: 'in-use', label: 'In use', count: 0 },
		{ id: 'chats', label: 'Old chats', count: 0 },
		{ id: 'everything', label: 'Everything', count: 0 }
	]);

	async function cleanAllSafe(): Promise<void> {
		cleaningAll = true;
		let freed = 0;
		let problems = 0;
		try {
			for (const estimate of safePending) {
				const result = await runCleanup({ action: estimate.action });
				freed += result.freedBytes;
				problems += result.errors.length;
			}
			addNotification({
				type: problems > 0 ? 'warning' : 'success',
				title: 'Storage cleaned up',
				message: `Freed ${formatBytes(freed)}${problems > 0 ? `, with ${problems} problem(s) — see Schedule → History` : ''}`,
				duration: 6000
			});
		} catch (error) {
			addNotification({ type: 'error', title: 'Storage', message: error instanceof Error ? error.message : 'Cleanup failed', duration: 6000 });
		} finally {
			cleaningAll = false;
		}
	}

	function actionLabel(id: CleanupActionId): string {
		return ACTION_COPY[id]?.label ?? id;
	}
</script>

<!-- A size container: the settings pane is far narrower than the viewport (and
     narrower still on a phone), so the grids below break on the pane's width,
     not the screen's. -->
<div class="py-1 @container">
	<div class="flex items-start justify-between gap-3 mb-4">
		<div class="min-w-0">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1">Storage</h3>
			<p class="text-sm text-slate-600 dark:text-slate-500 truncate">
				{#if report}
					{formatBytes(report.totalBytes)} used{#if reclaimableTotal > 0} · <span class="text-emerald-600 dark:text-emerald-400">{formatBytes(reclaimableTotal)} can go</span>{/if} · scanned {formatRelative(report.generatedAt)}
				{:else}
					What Clopen keeps on this machine, and what can go.
				{/if}
			</p>
		</div>
		<button
			type="button"
			onclick={() => { void rescanStorage(); void loadProjectFolders(); }}
			disabled={status.scanning}
			class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 enabled:hover:border-violet-500/40 enabled:hover:text-violet-600 dark:enabled:hover:text-violet-400 transition-colors cursor-pointer disabled:opacity-50"
		>
			<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {status.scanning ? 'animate-spin' : ''}" />
			{status.scanning ? `${status.phase ?? 'Scanning'}${status.progress !== null ? ` ${Math.round(status.progress * 100)}%` : '…'}` : 'Rescan'}
		</button>
	</div>

	{#if status.error && !status.scanning}
		<div class="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400">The last scan failed: {status.error}</div>
	{/if}
	{#if storageStore.error}
		<div class="mb-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400">{storageStore.error}</div>
	{/if}

	<div class="inline-flex gap-1 p-1 mb-4 bg-slate-100 dark:bg-slate-900 rounded-lg">
		{#each TABS as item (item.id)}
			<button
				type="button"
				aria-pressed={tab === item.id}
				onclick={() => (tab = item.id)}
				class="px-3 py-1 text-sm font-semibold rounded-md transition-colors cursor-pointer
				{tab === item.id ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
			>
				{item.label}
			</button>
		{/each}
	</div>

	{#if !report && tab !== 'schedule'}
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 p-5 animate-pulse">
			<div class="h-6 w-32 bg-slate-200 dark:bg-slate-700 rounded mb-3"></div>
			<div class="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded mb-4"></div>
			<div class="grid grid-cols-2 gap-2">
				{#each Array(6) as _, i (i)}
					<div class="h-3 bg-slate-200 dark:bg-slate-700 rounded"></div>
				{/each}
			</div>
		</div>
	{:else if tab === 'overview' && report}
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden mb-3">
			<div class="px-4 py-3.5">
				<div class="flex items-end justify-between gap-3 flex-wrap">
					<div class="min-w-0">
						<div class="text-2xl font-bold text-slate-900 dark:text-slate-100 font-mono">{formatBytes(report.totalBytes)}</div>
						<div class="text-xs text-slate-500 dark:text-slate-400 font-mono truncate" title={report.dataDir}>{report.dataDir}</div>
					</div>
					{#if report.disk}
						<div class="text-right text-xs text-slate-500 dark:text-slate-400">
							<div><span class="font-semibold text-slate-700 dark:text-slate-300">{formatBytes(report.disk.freeBytes)}</span> free of {formatBytes(report.disk.totalBytes)}</div>
							<div>Clopen: {clopenPercent < 0.1 ? '<0.1' : clopenPercent.toFixed(1)}% of the disk</div>
						</div>
					{/if}
				</div>
				<div class="mt-3 h-2.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden flex">
					{#each categories as category (category.id)}
						<div class="h-full {CATEGORY_COPY[category.id].color}" style="width: {(category.bytes / Math.max(1, report.totalBytes)) * 100}%" title="{CATEGORY_COPY[category.id].label}: {formatBytes(category.bytes)}"></div>
					{/each}
				</div>
			</div>

			<!-- Two columns of categories: the legend for the bar above. The longer
			     explanation of each is its tooltip. -->
			<div class="grid grid-cols-1 @md:grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 border-t border-slate-200 dark:border-slate-700/50">
				{#each categories as category (category.id)}
					<div class="flex items-center gap-2 min-w-0" title={CATEGORY_COPY[category.id].hint}>
						<span class="w-2 h-2 rounded-full shrink-0 {CATEGORY_COPY[category.id].color}"></span>
						<span class="text-xs text-slate-700 dark:text-slate-300 truncate">{CATEGORY_COPY[category.id].label}</span>
						<span class="ml-auto shrink-0 text-right">
							<span class="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100">{formatBytes(category.bytes)}</span>
							{#if category.reclaimableBytes > 0}
								<span class="block text-3xs font-mono text-emerald-600 dark:text-emerald-400">−{formatBytes(category.reclaimableBytes)}</span>
							{:else if category.id === 'stack'}
								<button type="button" class="block text-3xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer" onclick={() => setActiveSection('stack')}>Manage in Stack</button>
							{/if}
						</span>
					</div>
				{/each}
			</div>

			<div class="flex items-center justify-between gap-3 px-4 py-2.5 border-t border-slate-200 dark:border-slate-700/50 bg-slate-50 dark:bg-slate-900/30">
				<span class="text-xs text-slate-500 dark:text-slate-400">Unused data is anything nothing refers to.</span>
				<button
					type="button"
					onclick={cleanAllSafe}
					disabled={cleaningAll || storageStore.running !== null || safePending.length === 0}
					class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-violet-600 text-white enabled:hover:bg-violet-700 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{#if cleaningAll}
						<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
						Cleaning up…
					{:else}
						<Icon name="lucide:brush-cleaning" class="w-3.5 h-3.5" />
						{safePending.length === 0 ? 'Nothing unused' : `Remove unused (${formatBytes(safeReclaimable)})`}
					{/if}
				</button>
			</div>
		</div>

		{#if report.engines.length > 0}
			<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 px-4 py-3">
				<div class="text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-2">By engine</div>
				<div class="grid grid-cols-1 @md:grid-cols-2 gap-x-4 gap-y-2">
					{#each report.engines as engine (engine.engine)}
						<div
							class="flex items-center gap-2 min-w-0"
							title="{engine.transcriptCount} sessions ({formatBytes(engine.transcriptBytes)}) · {formatBytes(engine.otherBytes)} caches, logs and config{engine.redundantCount ? ` · ${engine.redundantCount} duplicate` : ''}{engine.orphanCount ? ` · ${engine.orphanCount} unused` : ''}"
						>
							<span class="text-xs text-slate-700 dark:text-slate-300 truncate">{engineLabel(engine.engine)}</span>
							<span class="text-3xs text-slate-400 truncate">{engine.transcriptCount} sessions</span>
							<span class="ml-auto shrink-0 text-right">
								<span class="text-xs font-mono font-semibold text-slate-900 dark:text-slate-100">{formatBytes(engine.transcriptBytes + engine.otherBytes)}</span>
								{#if engine.redundantBytes + engine.orphanBytes > 0}
									<span class="block text-3xs font-mono text-emerald-600 dark:text-emerald-400">−{formatBytes(engine.redundantBytes + engine.orphanBytes)}</span>
								{/if}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{:else if tab === 'cleanup' && report}
		<!-- One group at a time: the groups differ in what they cost, and
		     showing all fourteen actions at once was a page of scrolling. -->
		<div class="flex gap-1 p-1 mb-3 bg-slate-100 dark:bg-slate-900 rounded-lg w-fit">
			{#each GROUPS as item (item.id)}
				<button
					type="button"
					aria-pressed={group === item.id}
					onclick={() => (group = item.id)}
					class="px-2.5 py-1 text-xs font-semibold rounded-md transition-colors cursor-pointer
					{group === item.id ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 shadow-sm' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}"
				>
					{item.label}{#if item.count > 0} ({item.count}){/if}
				</button>
			{/each}
		</div>

		<p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
			{group === 'unused'
				? 'Nothing refers to these. Running chats and anything touched in the last few hours are always left alone.'
				: group === 'in-use'
					? 'In use, and comes back on its own — at the cost of a download, a sign-in or a short pause.'
					: group === 'chats'
						? 'Across every project. Open a project under Projects to narrow it to that project.'
						: 'Everything Clopen keeps, not only what is unused.'}
		</p>
		{#if group === 'everything'}
			<DataManagementSettings />
		{:else}
			<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden divide-y divide-slate-200 dark:divide-slate-700/60">
				{#if group === 'unused'}
					{#each safeActions as action (action.id)}
						<CleanupActionRow action={action.id} />
					{/each}
				{:else if group === 'in-use'}
					{#each cautionActions as action (action.id)}
						<CleanupActionRow action={action.id} />
					{/each}
					<CleanupActionRow action="stale-worktrees" defaultDays={60} />
				{:else}
					<CleanupActionRow action="slim-old-chats" defaultDays={90} />
					<CleanupActionRow action="delete-old-chats" defaultDays={365} />
				{/if}
			</div>
		{/if}
	{:else if tab === 'projects' && report}
		<p class="text-xs text-slate-500 dark:text-slate-400 mb-2">
			{formatBytes(report.totalBytes - report.unattributedBytes)} of Clopen’s data belongs to {report.projects.length} projects. Open one for its breakdown and cleanups.
		</p>
		<StorageProjects />
	{:else if tab === 'schedule'}
		<StoragePolicyCard />

		{#if storageStore.history.length > 0}
			<div class="mt-3 rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
				<div class="flex items-center justify-between px-4 pt-3 pb-1">
					<span class="text-2xs font-semibold uppercase tracking-wide text-slate-500">History</span>
					{#if storageStore.history.length > 4}
						<button type="button" class="text-2xs text-violet-600 dark:text-violet-400 hover:underline cursor-pointer" onclick={() => (showAllHistory = !showAllHistory)}>
							{showAllHistory ? 'Show less' : `Show all ${storageStore.history.length}`}
						</button>
					{/if}
				</div>
				<div class="divide-y divide-slate-200 dark:divide-slate-700/60 {showAllHistory ? 'max-h-72 overflow-y-auto' : ''}">
					{#each history as run (run.id)}
						<div class="flex items-center gap-3 px-4 py-2" title={run.error ?? ''}>
							<Icon
								name={run.error ? 'lucide:triangle-alert' : 'lucide:circle-check'}
								class="w-3.5 h-3.5 shrink-0 {run.error ? 'text-amber-500' : 'text-emerald-500'}"
							/>
							<span class="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">{actionLabel(run.action)}</span>
							<span class="text-2xs text-slate-500 truncate">
								{run.trigger === 'auto' ? 'scheduled' : run.trigger === 'delete' ? 'after a deletion' : 'by hand'} · {formatRelative(run.startedAt)}
							</span>
							<span class="ml-auto text-xs font-mono font-semibold text-slate-700 dark:text-slate-300 shrink-0">{formatBytes(run.freedBytes)}</span>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	{/if}
</div>
