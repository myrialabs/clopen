<script lang="ts">
	/**
	 * Scheduled cleanup: a master switch, how often, and which actions — with the
	 * same age each action takes by hand. Saved on every change.
	 */
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { CleanupActionId, StoragePolicy } from '$shared/types/storage';
	import { runPolicyNow, savePolicy, storageStore } from '$frontend/stores/features/storage.svelte';
	import { ACTION_COPY, formatRelative } from './storage-copy';

	const INTERVALS = [
		{ value: 6, label: 'Every 6 hours' },
		{ value: 12, label: 'Every 12 hours' },
		{ value: 24, label: 'Daily' },
		{ value: 72, label: 'Every 3 days' },
		{ value: 168, label: 'Weekly' }
	];
	const AGE_OPTIONS = [7, 14, 30, 60, 90, 180, 365];

	let saving = $state(false);

	const policy = $derived(storageStore.policy);
	const automatable = $derived(storageStore.actions.filter(action => action.automatable));

	async function update(next: StoragePolicy): Promise<void> {
		saving = true;
		try {
			await savePolicy(next);
		} catch (error) {
			addNotification({ type: 'error', title: 'Automatic cleanup', message: error instanceof Error ? error.message : 'Could not save', duration: 5000 });
		} finally {
			saving = false;
		}
	}

	function setAction(id: CleanupActionId, patch: { enabled?: boolean; olderThanDays?: number }): void {
		if (!policy) return;
		const current = policy.actions[id] ?? { enabled: false };
		void update({ ...policy, actions: { ...policy.actions, [id]: { ...current, ...patch } } });
	}

	async function runNow(): Promise<void> {
		await runPolicyNow();
		addNotification({ type: 'info', title: 'Automatic cleanup', message: 'Running the enabled cleanups now.', duration: 4000 });
	}
</script>

{#if policy}
	<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
		<button
			type="button"
			class="flex items-center justify-between gap-3 w-full text-left px-5 py-4 {policy.enabled ? 'border-b border-slate-200 dark:border-slate-700/50' : ''}"
			disabled={saving}
			onclick={() => update({ ...policy, enabled: !policy.enabled })}
		>
			<div class="flex items-center gap-3 min-w-0">
				<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 dark:bg-violet-500/15 shrink-0">
					<Icon name="lucide:calendar-clock" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
				</div>
				<div class="min-w-0">
					<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Clean up automatically</div>
					<p class="text-xs text-slate-500 dark:text-slate-400">
						Runs the cleanups switched on below while no chat is running. Last run {formatRelative(policy.lastRunAt)}.
					</p>
				</div>
			</div>
			<div class="relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0 {policy.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}">
				<div class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 {policy.enabled ? 'translate-x-4.5' : 'translate-x-0.5'}"></div>
			</div>
		</button>

		{#if policy.enabled}
			<div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-slate-200 dark:border-slate-700/50">
				<select
					value={policy.intervalHours}
					disabled={saving}
					onchange={(event) => update({ ...policy, intervalHours: Number((event.currentTarget as HTMLSelectElement).value) })}
					class="px-2 py-1 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
				>
					{#each INTERVALS as interval (interval.value)}
						<option value={interval.value}>{interval.label}</option>
					{/each}
				</select>
				<button
					type="button"
					onclick={runNow}
					disabled={storageStore.running !== null}
					class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 enabled:hover:border-violet-500/40 enabled:hover:text-violet-600 dark:enabled:hover:text-violet-400 transition-colors cursor-pointer disabled:opacity-50"
				>
					<Icon name="lucide:play" class="w-3.5 h-3.5" />
					Run now
				</button>
			</div>

			<!-- Two columns of compact switches on the card's own background:
			     thirteen full-width rows were a page of scrolling for what is a set
			     of on/off choices. -->
			<div class="grid grid-cols-1 @md:grid-cols-2 gap-x-6 px-5 py-2">
				{#each automatable as action (action.id)}
					{@const setting = policy.actions[action.id] ?? { enabled: false }}
					<div class="flex items-center gap-2 py-1.5 min-w-0">
						<button
							type="button"
							role="switch"
							aria-checked={setting.enabled}
							aria-label={ACTION_COPY[action.id].label}
							disabled={saving}
							onclick={() => setAction(action.id, { enabled: !setting.enabled })}
							class="relative w-8 h-[18px] rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer {setting.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"
						>
							<span class="absolute top-0.5 left-0 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 {setting.enabled ? 'translate-x-4' : 'translate-x-0.5'}"></span>
						</button>
						<span
							class="text-xs font-medium text-slate-800 dark:text-slate-200 truncate"
							title="{ACTION_COPY[action.id].description}{action.tier === 'destructive' ? ' — removes history' : action.tier === 'caution' ? ' — has a cost' : ''}"
						>
							{ACTION_COPY[action.id].label}
						</span>
						{#if action.tier !== 'safe'}
							<span class="w-1.5 h-1.5 rounded-full shrink-0 {action.tier === 'destructive' ? 'bg-red-500' : 'bg-amber-500'}" title={action.tier === 'destructive' ? 'Removes history' : 'Has a cost'}></span>
						{/if}
						{#if action.usesAge && setting.enabled}
							<select
								value={setting.olderThanDays ?? 90}
								disabled={saving}
								aria-label="Days without activity"
								onchange={(event) => setAction(action.id, { olderThanDays: Number((event.currentTarget as HTMLSelectElement).value) })}
								class="ml-auto shrink-0 px-1 py-0.5 text-2xs font-semibold rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
							>
								{#each AGE_OPTIONS as option (option)}
									<option value={option}>{option}d</option>
								{/each}
							</select>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/if}
