<script lang="ts">
	/**
	 * One cleanup action: what it removes, what it would free, and the button.
	 *
	 * Parameterless actions are priced by the last scan (the store's report);
	 * actions with an age or a project are priced on demand, and again whenever
	 * the age changes. Anything above the safe tier asks before it runs.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import { debug } from '$shared/utils/logger';
	import type { CleanupActionId, CleanupEstimate } from '$shared/types/storage';
	import { estimateCleanup, formatBytes, isSpent, runCleanup, storageStore } from '$frontend/stores/features/storage.svelte';
	import { ACTION_COPY } from './storage-copy';

	interface Props {
		action: CleanupActionId;
		projectId?: string | null;
		defaultDays?: number;
	}

	const { action, projectId = null, defaultDays = 90 }: Props = $props();

	const AGE_OPTIONS = [7, 14, 30, 60, 90, 180, 365];

	let days = $state(90);
	let onDemand = $state<CleanupEstimate | null>(null);
	let estimating = $state(false);
	let confirmOpen = $state(false);

	const meta = $derived(storageStore.actions.find(item => item.id === action) ?? null);
	const copy = $derived(ACTION_COPY[action]);
	const needsOnDemand = $derived(!!meta && (meta.usesAge || meta.projectScoped));
	const estimate = $derived(
		needsOnDemand ? onDemand : (storageStore.report?.estimates.find(item => item.action === action) ?? null)
	);
	const busy = $derived(storageStore.running !== null);
	const runningThis = $derived(storageStore.running === action);
	// Spent: ran against the current report. Off until a new report (the rescan
	// every cleanup triggers) shows something again.
	const spent = $derived(!needsOnDemand && isSpent({ action, projectId }));
	const nothingToDo = $derived(spent || (!!estimate && estimate.items === 0));

	$effect(() => {
		days = defaultDays;
	});

	let requestSeq = 0;
	async function refreshEstimate(): Promise<void> {
		if (!needsOnDemand) return;
		const seq = ++requestSeq;
		estimating = true;
		try {
			const result = await estimateCleanup({ action, projectId, ...(meta?.usesAge && { olderThanDays: days }) });
			if (seq === requestSeq) onDemand = result;
		} catch (error) {
			debug.warn('settings', `Could not price ${action}:`, error);
		} finally {
			if (seq === requestSeq) estimating = false;
		}
	}

	// Re-priced when the age changes, and after every scan (the report moving
	// means something was cleaned or written).
	$effect(() => {
		void days;
		void storageStore.report?.generatedAt;
		if (needsOnDemand) void refreshEstimate();
	});

	async function run(): Promise<void> {
		confirmOpen = false;
		try {
			const result = await runCleanup({ action, projectId, ...(meta?.usesAge && { olderThanDays: days }) });
			if (result.errors.length > 0) {
				addNotification({
					type: 'warning',
					title: copy.label,
					message: `Freed ${formatBytes(result.freedBytes)}, with ${result.errors.length} problem(s): ${result.errors[0]}`,
					duration: 8000
				});
			} else if (result.skippedReason && result.items === 0) {
				addNotification({ type: 'info', title: copy.label, message: result.skippedReason, duration: 6000 });
			} else {
				addNotification({
					type: 'success',
					title: copy.label,
					message: `Freed ${formatBytes(result.freedBytes)} (${result.items} item${result.items === 1 ? '' : 's'})${result.skippedReason ? ` — ${result.skippedReason}` : ''}`,
					duration: 5000
				});
			}
			void refreshEstimate();
		} catch (error) {
			addNotification({
				type: 'error',
				title: copy.label,
				message: error instanceof Error ? error.message : 'Cleanup failed',
				duration: 6000
			});
		}
	}

	// One line per paragraph; the dialog spaces them.
	const confirmMessage = $derived(
		[
			copy.description,
			copy.confirm,
			estimate && estimate.items > 0
				? `This affects ${estimate.items} item${estimate.items === 1 ? '' : 's'}${estimate.bytes > 0 ? ` (about ${formatBytes(estimate.bytes)})` : ''}.`
				: null
		]
			.filter(Boolean)
			.join('\n')
	);

	function start(): void {
		if (meta?.tier === 'safe') void run();
		else confirmOpen = true;
	}
</script>

<div class="flex items-start gap-3 px-4 py-2.5">
	<div
		class="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 mt-0.5
		{meta?.tier === 'destructive'
			? 'bg-red-500/10 text-red-500'
			: meta?.tier === 'caution'
				? 'bg-amber-500/10 text-amber-500'
				: 'bg-emerald-500/10 text-emerald-500'}"
	>
		<Icon name={copy.icon} class="w-4 h-4" />
	</div>

	<div class="flex-1 min-w-0">
		<div class="flex items-center gap-2 flex-wrap">
			<span class="text-[13px] font-semibold text-slate-900 dark:text-slate-100">{copy.label}</span>
			{#if estimate && estimate.items > 0 && !spent}
				<span class="text-2xs font-semibold font-mono px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-700/70 text-slate-700 dark:text-slate-300">
					{estimate.bytes > 0 ? formatBytes(estimate.bytes) : `${estimate.items} item${estimate.items === 1 ? '' : 's'}`}
				</span>
			{/if}
		</div>
		<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-2" title={copy.description}>{copy.description}</p>
		{#if meta?.usesAge}
			<label class="inline-flex items-center gap-1.5 mt-1.5 text-xs text-slate-600 dark:text-slate-400">
				No activity for
				<select
					bind:value={days}
					class="px-1.5 py-0.5 text-xs font-semibold rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
				>
					{#each AGE_OPTIONS as option (option)}
						<option value={option}>{option} days</option>
					{/each}
				</select>
				{#if estimate}
					<span class="text-slate-400">· {estimate.items} {action === 'stale-worktrees' ? 'worktree' : action === 'project-profiles' ? 'profile' : 'chat'}{estimate.items === 1 ? '' : 's'}</span>
				{/if}
			</label>
		{/if}
	</div>

	<button
		type="button"
		disabled={busy || estimating || nothingToDo}
		onclick={start}
		class="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed
		{meta?.tier === 'destructive'
			? 'border-red-500/30 text-red-600 dark:text-red-400 enabled:hover:bg-red-500/10'
			: 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 enabled:hover:border-violet-500/40 enabled:hover:text-violet-600 dark:enabled:hover:text-violet-400'}"
	>
		{#if runningThis}
			<Icon name="lucide:loader-circle" class="w-3.5 h-3.5 animate-spin" />
			Working…
		{:else if nothingToDo}
			<Icon name="lucide:circle-check" class="w-3.5 h-3.5" />
			Clean
		{:else}
			{action === 'compact-database' ? 'Compact' : action.startsWith('delete') ? 'Delete' : action.startsWith('slim') ? 'Slim' : 'Clean up'}
		{/if}
	</button>
</div>

<Dialog
	bind:isOpen={confirmOpen}
	onClose={() => (confirmOpen = false)}
	title={copy.label}
	type={meta?.tier === 'destructive' ? 'error' : 'warning'}
	message={confirmMessage}
	confirmText={action.startsWith('delete') ? 'Delete' : 'Continue'}
	cancelText="Cancel"
	onConfirm={() => void run()}
/>
