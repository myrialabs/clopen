<script lang="ts">
	/**
	 * Settings → Infrastructure → Memory — what memory does, not which model writes it.
	 *
	 * Three switches under one master, a recall budget, and what is actually
	 * stored. Grouped rather than listed: the earlier flat wall of toggles and
	 * statistics had all the same information and no shape, so nothing stood out
	 * as the thing you were looking for.
	 */
	import { onMount } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { memoryGraphStore } from '$frontend/stores/features/memory-graph.svelte';
	import { memoryReadinessStore } from '$frontend/stores/features/memory-readiness.svelte';
	import { openMemoryDialog } from '$frontend/stores/ui/quick-panels.svelte';
	import { settingsModalState } from '$frontend/stores/ui/settings-modal.svelte';
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import { showAlert } from '$frontend/stores/ui/dialog.svelte';
	import MemoryStatus from '$frontend/components/memory/MemoryStatus.svelte';

	let saving = $state(false);
	let purging = $state(false);
	let error = $state<string | null>(null);
	let purgeDialogOpen = $state(false);
	let purgeTyped = $state('');

	const config = $derived(memoryGraphStore.config);
	const stats = $derived(memoryGraphStore.stats);

	// Readiness comes from its own store rather than from `stats.embedding`: the
	// latter reports whether the table LOADED, this reports whether the download
	// is running, waiting on a retry, or has given up — which is what decides
	// whether the button below says "Download now" or "Try again".
	const embedding = $derived(memoryReadinessStore.readiness?.embedding ?? null);
	const downloadingModel = $derived(embedding?.phase === 'downloading' || memoryReadinessStore.installing);
	const modelPercent = $derived(
		embedding && embedding.totalBytes > 0
			? Math.min(100, Math.round((embedding.receivedBytes / embedding.totalBytes) * 100))
			: 0
	);

	onMount(() => {
		void memoryGraphStore.fetchConfig();
		void memoryGraphStore.refreshStats();
		void memoryGraphStore.refreshStatus();
		const offGraph = memoryGraphStore.subscribeToChanges();
		const offReadiness = memoryReadinessStore.subscribe();
		return () => {
			offGraph();
			offReadiness();
		};
	});

	async function save(patch: Record<string, unknown>): Promise<void> {
		saving = true;
		error = null;
		try {
			await memoryGraphStore.saveConfig(patch);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	const behaviours = $derived(
		config
			? [
					{
						key: 'recordMemories',
						value: config.recordMemories,
						title: 'Record what is decided',
						description:
							'As soon as a turn finishes, summarise what it established — decisions, preferences, failures, facts — into memories.'
					},
					{
						key: 'recordCode',
						value: config.recordCode,
						title: 'Map the code',
						description:
							'Track the files and symbols each turn touches, read from changes on disk — so edits made through a script or the shell count too.'
					},
					{
						key: 'autoRecall',
						value: config.autoRecall,
						title: 'Recall automatically',
						description:
							'Hand the agent whatever is relevant at the start of each turn, with no prompting. It can always search deeper itself.'
					}
				]
			: []
	);

	/**
	 * Empty the graph entirely.
	 *
	 * Typing the word is the confirmation rather than a single OK, because this is
	 * the only action on this page with no undo of any kind. `Dialog` already
	 * supports an input and a disabled confirm button, so that safety costs nothing
	 * and stays inside the app's own dialog system.
	 */
	async function confirmPurge(): Promise<void> {
		if (purgeTyped.trim() !== 'DELETE') return;

		purging = true;
		error = null;
		try {
			const result = await memoryGraphStore.purge();
			await memoryGraphStore.refreshStats();
			await showAlert({
				title: 'Memory cleared',
				message: `Removed ${result.nodes} memory node(s) and ${result.edges} connection(s).`,
				type: 'success'
			});
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			purging = false;
		}
	}

	function openMemory(): void {
		settingsModalState.isOpen = false;
		openMemoryDialog();
	}
</script>

<div class="py-1">
	<h3 class="text-base font-bold text-slate-900 dark:text-slate-100 mb-1.5">Memory</h3>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">
		What this workspace remembers, shared by every engine.
	</p>

	<!--
		Mirrors the card on Settings → Model → Memory. This page and that one answer
		different questions — what memory does, versus which model writes it — and
		splitting them was right, but a split with no link between the halves just
		makes each one harder to find from the other.
	-->
	<div class="flex items-start gap-2.5 p-3 mb-4 rounded-xl bg-slate-500/5 dark:bg-slate-400/5 border border-slate-200 dark:border-slate-700/60">
		<Icon name="lucide:info" class="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
		<p class="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
			Recording happens on its own after every turn, using a model you pick once under
			<button type="button" class="text-violet-600 dark:text-violet-400 hover:underline cursor-pointer font-medium" onclick={() => (settingsModalState.activeSection = 'memory')}>Settings → Model → Memory</button>.
			Recalling costs no model call at all, so it runs on every turn for free.
		</p>
	</div>

	{#if error}
		<div class="mb-4 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 text-xs text-red-600 dark:text-red-400">
			{error}
		</div>
	{/if}

	{#if !config}
		<p class="text-sm text-slate-400">Loading…</p>
	{:else}
		<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden mb-5">
			<!-- Master switch -->
			<button
				type="button"
				class="flex items-center justify-between gap-3 w-full text-left px-5 py-4 {config.enabled
					? 'border-b border-slate-200 dark:border-slate-700/50'
					: ''}"
				disabled={saving}
				onclick={() => save({ enabled: !config.enabled })}
			>
				<div class="flex items-center gap-3 min-w-0">
					<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 dark:bg-violet-500/15 shrink-0">
						<Icon name="lucide:brain" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
					</div>
					<div class="min-w-0">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Remember across sessions</div>
						<p class="text-xs text-slate-500 dark:text-slate-400">
							When off, nothing is recorded and no memory reaches any agent. What is already stored is kept.
						</p>
					</div>
				</div>
				<div
					class="relative w-9 h-5 rounded-full transition-colors duration-200 shrink-0
					{config.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"
				>
					<div
						class="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200
						{config.enabled ? 'translate-x-4.5' : 'translate-x-0.5'}"
					></div>
				</div>
			</button>

			{#if config.enabled}
				<div class="divide-y divide-slate-200 dark:divide-slate-700">
					{#each behaviours as behaviour (behaviour.key)}
						<button
							type="button"
							class="flex items-center justify-between gap-3 w-full text-left py-3.5 pl-[68px] pr-5"
							disabled={saving}
							onclick={() => save({ [behaviour.key]: !behaviour.value })}
						>
							<div class="min-w-0">
								<span class="text-[13px] font-medium text-slate-800 dark:text-slate-200">{behaviour.title}</span>
								<p class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{behaviour.description}</p>
							</div>
							<div
								class="relative w-8 h-[18px] rounded-full transition-colors duration-200 flex-shrink-0
								{behaviour.value ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-600'}"
							>
								<div
									class="absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform duration-200
									{behaviour.value ? 'translate-x-4' : 'translate-x-0.5'}"
								></div>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		{#if config.enabled}

			<!--
				THERE IS NO "HOW MUCH TO RECALL" CONTROL, and its absence is the third
				and last answer to a question that had two wrong ones.

				It was a character budget first, which did not bound what it claimed to:
				measured, its lowest setting produced a block 79% over the number chosen
				and its highest silently undershot. A count of memories fixed the
				arithmetic and left the real problem — relevance is not uniform, so no
				single number is right for both "ok, continue" and a turn that lands on
				something the graph knows well.

				Each turn now takes the memories that are close to its own best match and
				stops when they fall away, so the amount follows the question. Nothing to
				set, and nothing to get wrong.
			-->


			<!--
				Placed above "What is stored", because a count of what has been recorded
				is misleading on its own if the reason it is not growing is that recording
				has been failing.
			-->
			<div class="mb-5">
				<MemoryStatus variant="block" canRetry />
			</div>

			<!-- What is stored -->
			<div class="rounded-xl border border-slate-200 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 overflow-hidden">
				<div class="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-200 dark:border-slate-700/50">
					<div class="flex items-center gap-3 min-w-0">
						<div class="flex items-center justify-center w-9 h-9 rounded-lg bg-violet-500/10 dark:bg-violet-500/15 shrink-0">
							<Icon name="lucide:database" class="w-5 h-5 text-violet-600 dark:text-violet-400" />
						</div>
						<div class="min-w-0">
							<h4 class="font-semibold text-slate-900 dark:text-slate-100">What is stored</h4>
							<p class="text-xs text-slate-500 dark:text-slate-400">Counts and search readiness for this workspace's graph</p>
						</div>
					</div>
					<button
						type="button"
						class="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors shrink-0"
						onclick={openMemory}
					>
						<Icon name="lucide:external-link" class="w-3.5 h-3.5" />
						Open Memory
					</button>
				</div>

				<div class="px-5 py-4">
					{#if stats}
						<div class="grid grid-cols-3 gap-3 mb-3">
							{#each [{ label: 'Memories', value: stats.episodic }, { label: 'Code entities', value: stats.structural }, { label: 'Connections', value: stats.edges }, { label: 'Subjects', value: stats.entities }, { label: 'Proved useful', value: stats.confirmedUseful }, { label: 'Forgotten', value: stats.forgotten }] as metric (metric.label)}
								<div>
									<div class="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-none">
										{metric.value}
									</div>
									<div class="text-[10px] text-slate-500 dark:text-slate-400 mt-1">{metric.label}</div>
								</div>
							{/each}
						</div>

						{#if stats.stale > 0}
							<p class="text-[11px] text-slate-500 dark:text-slate-400 mb-2.5">
								{stats.stale} describe code that has changed since — still recalled, but ranked below what
								has not.
							</p>
						{/if}

					<!--
							The local search model is a PREREQUISITE, not an enhancement, so
							this reports readiness rather than progress. Saying "search still
							works on keywords" was the old copy and it was misleading: recall
							is gated on this now, because a lexical-only result set is
							indistinguishable from a complete one to whatever consumes it.
						-->
						<div class="flex items-start gap-2 pt-2.5 border-t border-slate-200 dark:border-slate-700">
							<Icon
								name={embedding?.ready
									? 'lucide:check'
									: downloadingModel
										? 'lucide:loader-circle'
										: 'lucide:triangle-alert'}
								class="w-3.5 h-3.5 mt-0.5 shrink-0 {embedding?.ready
									? 'text-emerald-500'
									: downloadingModel
										? 'text-sky-500 animate-spin'
										: 'text-amber-500'}"
							/>
							<div class="text-xs text-slate-500 dark:text-slate-400 min-w-0">
								{#if embedding?.ready}
									<p>
										Meaning-based search runs locally — {stats.vectors} indexed, no API key and no
										network call. Questions match memories that share no words with them.
									</p>
								{:else if downloadingModel}
									<p>
										Downloading the local search model ({modelPercent}%). Conversations are still being
										recorded and become searchable the moment it lands.
									</p>
								{:else}
									<p class="text-amber-600 dark:text-amber-400">
										Recall is off until the local search model is installed. Recording continues, so
										nothing said in the meantime is lost.
									</p>
									{#if embedding?.error}
										<p class="mt-1 font-mono text-[10px] break-all opacity-70">{embedding.error}</p>
									{/if}
									<button
										onclick={() => memoryReadinessStore.install()}
										disabled={memoryReadinessStore.installing}
										class="mt-2 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white transition-colors"
									>
										{memoryReadinessStore.installing
											? 'Installing…'
											: embedding && embedding.attempts > 0
												? 'Try again'
												: 'Download now'}
									</button>
								{/if}
							</div>
						</div>
					{:else}
						<p class="text-xs text-slate-400">Loading…</p>
					{/if}
				</div>
			</div>
		{/if}

		<!--
			Outside the `config.enabled` branch on purpose. Turning memory off does not
			delete what is already stored — the master switch says so explicitly — so
			someone who switched it off in order to be rid of the data would otherwise
			find no way to actually do that.
		-->
		<div class="mt-5">
			<div class="flex items-center gap-2 mb-3 text-xs font-medium text-red-600 dark:text-red-400">
				<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
				<span>Danger Zone</span>
			</div>
			<div
				class="flex items-center justify-between gap-4 p-4 bg-red-500/5 dark:bg-red-500/5 border border-red-500/20 dark:border-red-500/20 rounded-lg max-sm:flex-col max-sm:items-stretch"
			>
				<div class="flex-1">
					<div class="text-sm font-medium text-slate-900 dark:text-slate-100 mb-1">Delete everything</div>
					<div class="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
						Permanently delete every memory, code entity and connection, across all projects. This cannot be undone.
					</div>
				</div>
				<button
					type="button"
					class="flex items-center justify-center gap-2 py-2 px-4 bg-red-500/10 border border-red-500/25 rounded-lg text-red-600 dark:text-red-400 text-sm font-medium cursor-pointer transition-all duration-150 whitespace-nowrap hover:bg-red-500/15 hover:border-red-500/35 disabled:opacity-60 disabled:cursor-not-allowed"
					disabled={purging}
					onclick={() => {
						purgeTyped = '';
						purgeDialogOpen = true;
					}}
				>
					{#if purging}
						<div
							class="w-3.5 h-3.5 border-2 border-red-600/30 dark:border-red-400/30 border-t-red-600 dark:border-t-red-400 rounded-full animate-spin"
						></div>
						<span>Deleting...</span>
					{:else}
						<Icon name="lucide:trash-2" class="w-4 h-4" />
						<span>Delete all memory</span>
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>

<!--
	Typed confirmation, for the same reason the Memory modal uses one: a single OK
	button is too small a gesture for an action with no undo at all.
-->
<Dialog
	bind:isOpen={purgeDialogOpen}
	bind:inputValue={purgeTyped}
	onClose={() => (purgeDialogOpen = false)}
	title="Delete all memory"
	type="error"
	message={'Every memory, code entity and connection will be removed, across all projects. Forgotten memories can be restored; these cannot, because there will be nothing left to restore.\nType DELETE to confirm.'}
	inputPlaceholder="DELETE"
	confirmText="Delete everything"
	cancelText="Cancel"
	confirmDisabled={purgeTyped.trim() !== 'DELETE'}
	onConfirm={() => void confirmPurge()}
/>
