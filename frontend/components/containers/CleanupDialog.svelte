<!--
	Containers — reclaiming disk, with the numbers in front of the button.

	A single "clean up" button would be the wrong shape here: the six kinds of
	sweep differ enormously in what they cost to undo. A stopped container is
	nothing to lose; every unused image is a pull or a build to get back, and on
	a slow connection that is an afternoon. So each is its own choice, each says
	what it would reclaim, and the two that hurt are off until they are asked
	for.

	The figures come from `system df` on the host, not from anything computed
	here — the runtime is the authority on its own disk, and a number invented in
	the browser is exactly the one nobody could trust.
-->
<script lang="ts">
	import Dialog from '$frontend/components/common/overlay/Dialog.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import { containersStore } from '$frontend/stores/features/containers.svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { PruneKind } from '$shared/types/containers';

	interface Props {
		isOpen: boolean;
		onClose: () => void;
	}

	let { isOpen = $bindable(), onClose }: Props = $props();

	interface Sweep {
		kind: PruneKind;
		label: string;
		blurb: string;
		/** Which `system df` row speaks for it, when one does. */
		usage: 'containers' | 'images' | 'volumes' | 'build-cache' | null;
		/** True for the two that cost real time to undo. */
		heavy: boolean;
	}

	const SWEEPS: Sweep[] = [
		{
			kind: 'containers',
			label: 'Stopped containers',
			blurb: 'Containers that have exited. Their volumes are kept.',
			usage: 'containers',
			heavy: false
		},
		{
			kind: 'dangling-images',
			label: 'Dangling images',
			blurb: 'Untagged layers left behind by rebuilds.',
			usage: null,
			heavy: false
		},
		{
			kind: 'networks',
			label: 'Unused networks',
			blurb: 'Networks with nothing attached. The built-in ones are left alone.',
			usage: null,
			heavy: false
		},
		{
			kind: 'build-cache',
			label: 'Build cache',
			blurb: 'Cached layers. The next build is slower, and correct.',
			usage: 'build-cache',
			heavy: false
		},
		{
			kind: 'images',
			label: 'All unused images',
			blurb: 'Every image no container uses — not just the untagged ones.',
			usage: 'images',
			heavy: true
		},
		{
			kind: 'volumes',
			label: 'Unused volumes',
			blurb: 'Every volume no container mounts, named ones included. Their contents go with them.',
			usage: 'volumes',
			heavy: true
		}
	];

	const selected = new SvelteSet<PruneKind>(['containers', 'dangling-images']);

	const usage = $derived(containersStore.diskUsage);
	const measuring = $derived(containersStore.diskUsageMeasuring);
	// The sweep belongs to the host, so all three of these come from the server:
	// this dialog is often not the one that started it, and sometimes not even
	// the same browser.
	const job = $derived(containersStore.pruneJob);
	const running = $derived(containersStore.pruning);
	const outcomes = $derived(job?.outcomes ?? null);

	/**
	 * How old the figures are, in the roughest terms that are still true.
	 *
	 * Worth saying at all because the reading is cached: walking the disk takes
	 * as long as the disk is large, so a dialog that re-measured on every open
	 * would spend a minute of the host's time redrawing numbers that had not
	 * moved. Anything under a minute is close enough to now to say so.
	 */
	function ageOf(measuredAt: string | null): string | null {
		if (!measuredAt) return null;
		const then = Date.parse(measuredAt);
		if (Number.isNaN(then)) return null;
		const minutes = Math.floor((now - then) / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes === 1) return '1 minute ago';
		if (minutes < 60) return `${minutes} minutes ago`;
		const hours = Math.floor(minutes / 60);
		return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
	}

	// Ticks only while the dialog is open, so the age does not go stale on screen.
	let now = $state(Date.now());
	$effect(() => {
		if (!isOpen) return;
		const timer = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(timer);
	});
	const anyHeavy = $derived(SWEEPS.some((sweep) => sweep.heavy && selected.has(sweep.kind)));

	function reclaimableFor(sweep: Sweep): string | null {
		if (!sweep.usage) return null;
		return usage?.rows.find((row) => row.kind === sweep.usage)?.reclaimable ?? null;
	}

	function toggle(kind: PruneKind): void {
		if (selected.has(kind)) selected.delete(kind);
		else selected.add(kind);
	}

	function labelFor(kind: PruneKind): string {
		return SWEEPS.find((sweep) => sweep.kind === kind)?.label ?? kind;
	}

	/** How long the running sweep has been going, in the terms `ageOf` uses. */
	const runningFor = $derived(job && !job.finishedAt ? ageOf(job.startedAt) : null);

	$effect(() => {
		if (!isOpen) return;
		now = Date.now();
		// Both are server-owned and both may already be in progress: a sweep
		// started before this dialog existed has to be found, not assumed absent.
		void containersStore.loadDiskUsage();
		void containersStore.loadPruneStatus();
	});

	// While a sweep runs, the checkboxes show what it is actually sweeping rather
	// than whatever this dialog happened to be left on.
	$effect(() => {
		const kinds = job && !job.finishedAt ? job.kinds : null;
		if (!kinds) return;
		selected.clear();
		for (const kind of kinds) selected.add(kind);
	});

	/**
	 * Start the sweep and stop there.
	 *
	 * Nothing is awaited: the sweep runs on the host for as long as it takes, and
	 * how it went is reported by the store — which is still there whether or not
	 * this dialog is.
	 */
	function run(): void {
		if (running) return;
		const kinds = SWEEPS.filter((sweep) => selected.has(sweep.kind)).map((sweep) => sweep.kind);
		if (kinds.length === 0) return;
		void containersStore.prune(kinds);
	}

	/** Closing after a sweep is the acknowledgement that its report was read. */
	function close(): void {
		if (outcomes) void containersStore.dismissPrune();
		onClose();
	}
</script>

<Dialog
	bind:isOpen
	onClose={close}
	type="warning"
	title="Clean up this host"
	maxWidth="max-w-xl"
	confirmText={running ? 'Cleaning…' : 'Clean up'}
	confirmDisabled={running || selected.size === 0}
	cancelText={outcomes ? 'Done' : 'Close'}
	onConfirm={run}
	closeOnConfirm={false}
>
	{#snippet children()}
		<div class="flex flex-col gap-3">
			<p class="m-0 text-xs text-slate-600 dark:text-slate-400">
				Only things nothing is using are removed — a running container keeps its image, its
				volumes and its network. Everything else is gone for good.
			</p>

			<!-- Said plainly because the sweep genuinely does not need this dialog:
			     it runs on the host, and closing this changes nothing about it. -->
			{#if running}
				<div
					class="flex items-start gap-2 p-2.5 rounded-lg bg-blue-500/10 text-xs text-blue-800 dark:text-blue-300"
				>
					<Icon name="lucide:loader-circle" class="w-4 h-4 shrink-0 mt-px animate-spin" />
					<span>
						Sweeping {job?.kinds.map(labelFor).join(', ').toLowerCase()}{runningFor &&
						runningFor !== 'just now'
							? `, started ${runningFor}`
							: ''}. Runs on the host — closing this will not stop it.
					</span>
				</div>
			{/if}

			{#if usage && usage.rows.length > 0}
				<div class="flex flex-col gap-1.5">
					<div class="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
						{#each usage.rows as row (row.kind)}
							<div class="flex flex-col p-2 rounded-lg bg-slate-100 dark:bg-slate-950">
								<span
									class="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-500"
								>
									{row.kind === 'build-cache' ? 'build cache' : row.kind}
								</span>
								<span class="text-sm font-semibold text-slate-800 dark:text-slate-200">
									{row.size}
								</span>
								<span class="text-[11px] text-emerald-600 dark:text-emerald-400">
									{row.reclaimable} free
								</span>
							</div>
						{/each}
					</div>

					<!-- The figures are cached, so how old they are is part of reading
					     them. Measuring again is a deliberate act, not something the
					     dialog does behind the user on every open. -->
					<div class="flex items-center gap-2 text-[11px] text-slate-400 dark:text-slate-500">
						{#if measuring}
							<Icon name="lucide:loader-circle" class="w-3 h-3 animate-spin" />
							<span>Measuring again — can take a minute.</span>
						{:else}
							{@const age = ageOf(usage.measuredAt)}
							<span>Measured {age ?? 'at an unknown time'}.</span>
							<button
								type="button"
								class="underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300
									transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
								disabled={running}
								onclick={() => containersStore.loadDiskUsage(true)}
							>
								Re-check
							</button>
						{/if}
					</div>
				</div>
			{:else if measuring}
				<div class="flex items-center gap-2 text-xs text-slate-400">
					<Icon name="lucide:loader-circle" class="flex-none w-3.5 h-3.5 animate-spin" />
					<span>Measuring what this host holds — can take a minute. Sweeps work meanwhile.</span>
				</div>
			{:else if usage?.error}
				<p class="m-0 text-xs text-amber-600 dark:text-amber-400">
					This host would not report its disk usage: {usage.error}
				</p>
			{/if}

			<div class="flex flex-col gap-1">
				{#each SWEEPS as sweep (sweep.kind)}
					{@const reclaimable = reclaimableFor(sweep)}
					<label
						class="flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors hover:bg-slate-100 dark:hover:bg-slate-800/60"
					>
						<input
							type="checkbox"
							class="mt-0.5 w-4 h-4 shrink-0 accent-violet-600 cursor-pointer"
							checked={selected.has(sweep.kind)}
							disabled={running}
							onchange={() => toggle(sweep.kind)}
						/>
						<span class="flex flex-col min-w-0 flex-1">
							<span class="flex items-center gap-1.5">
								<span class="text-sm font-medium text-slate-800 dark:text-slate-200">
									{sweep.label}
								</span>
								{#if sweep.heavy}
									<span
										class="shrink-0 px-1 py-px rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-700 dark:text-amber-400"
										title="Slow or impossible to undo"
									>
										costly
									</span>
								{/if}
								{#if reclaimable}
									<span class="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">
										up to {reclaimable}
									</span>
								{/if}
							</span>
							<span class="text-xs text-slate-500 dark:text-slate-500">{sweep.blurb}</span>
						</span>
					</label>
				{/each}
			</div>

			{#if anyHeavy && !outcomes}
				<p
					class="m-0 flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/10 text-xs text-amber-800 dark:text-amber-300"
				>
					<Icon name="lucide:triangle-alert" class="w-4 h-4 shrink-0 mt-px" />
					<span>
						Unused images have to be pulled or built again, and a deleted volume's contents are
						not recoverable. Nothing on this host keeps a copy.
					</span>
				</p>
			{/if}

			{#if outcomes}
				<div class="flex flex-col gap-1 pt-1 border-t border-slate-200 dark:border-slate-800">
					{#each outcomes as outcome (outcome.kind)}
						<div class="flex items-center gap-2 text-xs">
							<Icon
								name={outcome.ok ? 'lucide:circle-check' : 'lucide:circle-x'}
								class="w-3.5 h-3.5 shrink-0 {outcome.ok
									? 'text-emerald-600 dark:text-emerald-400'
									: 'text-red-600 dark:text-red-400'}"
							/>
							<span class="text-slate-700 dark:text-slate-300">{labelFor(outcome.kind)}</span>
							<span class="text-slate-500 dark:text-slate-500 truncate">
								{#if !outcome.ok}
									{outcome.error}
								{:else if outcome.removed === 0}
									nothing to remove
								{:else}
									{outcome.removed} removed{outcome.reclaimed ? ` · ${outcome.reclaimed} freed` : ''}
								{/if}
							</span>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	{/snippet}
</Dialog>
