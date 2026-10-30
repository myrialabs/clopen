<script lang="ts">
	/**
	 * What the preview browser is costing, right now.
	 *
	 * A slow machine with the preview open raised a question nothing could
	 * answer: is it the preview? Each workspace runs a Chrome of its own, every
	 * tab is a renderer, and a tab nobody is looking at sleeps but keeps its
	 * memory. This puts numbers on all of it — the host's headroom, each Chrome's
	 * process tree, and what every tab of this workspace is doing — so the
	 * answer is read rather than guessed, and a tab can be closed from the row
	 * that shows its cost.
	 *
	 * Polled only while open. Nothing here runs script in a page, so looking at
	 * a sleeping tab does not wake it.
	 */
	import Modal from '$frontend/components/common/overlay/Modal.svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	type Diagnostics = Awaited<ReturnType<typeof fetchDiagnostics>>;

	let { isOpen = $bindable(false) }: { isOpen: boolean } = $props();

	const POLL_MS = 2000;

	let data = $state<Diagnostics | null>(null);
	let error = $state<string | null>(null);
	let closing = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;

	/** Previous stream counters per tab, for turning totals into rates. */
	let previousStreams = new Map<string, { bytes: number; frames: number; at: number }>();
	let rates = $state<Record<string, { fps: number; kbps: number }>>({});

	function fetchDiagnostics() {
		return ws.http('preview:browser-diagnostics', {}, 10000);
	}

	async function refresh() {
		try {
			const next = await fetchDiagnostics();

			const nextRates: Record<string, { fps: number; kbps: number }> = {};
			const nextPrevious = new Map<string, { bytes: number; frames: number; at: number }>();
			for (const tab of next.tabs) {
				if (!tab.stream) continue;
				const sample = { bytes: tab.stream.videoBytesSent, frames: tab.stream.videoFramesEncoded, at: next.timestamp };
				const before = previousStreams.get(tab.id);
				if (before && sample.at > before.at && sample.frames >= before.frames) {
					const seconds = (sample.at - before.at) / 1000;
					nextRates[tab.id] = {
						fps: Math.round((sample.frames - before.frames) / seconds),
						kbps: Math.round(((sample.bytes - before.bytes) * 8) / 1000 / seconds)
					};
				}
				nextPrevious.set(tab.id, sample);
			}
			previousStreams = nextPrevious;
			rates = nextRates;

			data = next;
			error = null;
		} catch (err) {
			debug.warn('preview', 'Could not read preview diagnostics:', err);
			error = err instanceof Error ? err.message : 'Could not read diagnostics';
		}

		if (isOpen) timer = setTimeout(refresh, POLL_MS);
	}

	function start() {
		stop();
		previousStreams = new Map();
		rates = {};
		void refresh();
	}

	function stop() {
		if (timer) clearTimeout(timer);
		timer = null;
	}

	$effect(() => {
		if (!isOpen) stop();
		return stop;
	});

	async function closeTab(tabId: string) {
		closing = tabId;
		try {
			await ws.http('preview:browser-tab-close', { tabId });
		} catch (err) {
			debug.warn('preview', 'Could not close the tab from diagnostics:', err);
		} finally {
			closing = null;
		}
	}

	function bytes(value: number | null | undefined): string {
		if (value === null || value === undefined) return '—';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let size = value;
		let unit = 0;
		while (size >= 1024 && unit < units.length - 1) {
			size /= 1024;
			unit += 1;
		}
		return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
	}

	function ago(timestamp: number): string {
		const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
		if (seconds < 60) return `${seconds}s ago`;
		const minutes = Math.round(seconds / 60);
		if (minutes < 60) return `${minutes}m ago`;
		return `${Math.round(minutes / 60)}h ago`;
	}

	const host = $derived(data?.host ?? null);
	const usedRatio = $derived(host ? 1 - host.availableMemBytes / host.totalMemBytes : 0);
	const current = $derived(data?.browsers.find((browser) => browser.current) ?? null);
	const others = $derived(data?.browsers.filter((browser) => !browser.current) ?? []);
	const othersRss = $derived(others.reduce((sum, browser) => sum + browser.rssBytes, 0));
	const allRss = $derived((current?.rssBytes ?? 0) + othersRss);
</script>

<Modal {isOpen} onClose={() => (isOpen = false)} onOpened={start} title="Preview diagnostics" size="lg">
	<div class="space-y-5 text-sm">
		{#if error && !data}
			<p class="text-red-600 dark:text-red-400">{error}</p>
		{:else if !data}
			<div class="flex items-center justify-center gap-2 py-10 text-slate-500">
				<Icon name="lucide:loader" class="h-4 w-4 animate-spin" />
				<span>Measuring…</span>
			</div>
		{:else}
			<!-- Host -->
			<section class="space-y-2">
				<div class="flex items-baseline justify-between gap-3">
					<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">This machine</h3>
					{#if host}
						<span class="text-xs text-slate-500 dark:text-slate-400">
							{host.cpuCount} cores · load {host.loadAverage.map((value) => value.toFixed(1)).join(' / ')}
						</span>
					{/if}
				</div>
				{#if host}
					<div class="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
						<div
							class="h-full rounded-full transition-all {usedRatio > 0.9
								? 'bg-red-500'
								: usedRatio > 0.75
									? 'bg-amber-500'
									: 'bg-emerald-500'}"
							style="width: {Math.min(100, Math.round(usedRatio * 100))}%"
						></div>
					</div>
					<p class="text-xs text-slate-500 dark:text-slate-400">
						{bytes(host.availableMemBytes)} available of {bytes(host.totalMemBytes)} — preview browsers use
						<span class="font-medium text-slate-700 dark:text-slate-200">{bytes(allRss)}</span> of it.
					</p>
				{/if}
			</section>

			<!-- Chromes -->
			<section class="space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Preview browsers</h3>
				<div class="grid grid-cols-2 gap-2">
					<div class="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
						<p class="text-xs text-slate-500 dark:text-slate-400">This workspace</p>
						{#if current}
							<p class="mt-1 font-medium text-slate-800 dark:text-slate-100">{bytes(current.rssBytes)}</p>
							<p class="text-xs text-slate-500 dark:text-slate-400">
								{current.processes} processes{current.cpuPercent !== null ? ` · ${current.cpuPercent}% CPU` : ''}
							</p>
						{:else}
							<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Not running</p>
						{/if}
					</div>
					<div class="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
						<p class="text-xs text-slate-500 dark:text-slate-400">Other workspaces</p>
						<p class="mt-1 font-medium text-slate-800 dark:text-slate-100">{bytes(othersRss)}</p>
						<p class="text-xs text-slate-500 dark:text-slate-400">
							{others.length} running · {others.reduce((sum, browser) => sum + browser.tabs, 0)} tabs
						</p>
					</div>
				</div>
			</section>

			<!-- Tabs -->
			<section class="space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
					Tabs in this workspace ({data.tabs.length})
				</h3>
				{#if data.tabs.length === 0}
					<p class="text-xs text-slate-500 dark:text-slate-400">No tabs open.</p>
				{:else}
					<ul class="divide-y divide-slate-200 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
						{#each data.tabs as tab (tab.id)}
							<li class="flex items-start gap-3 p-3">
								<div class="min-w-0 flex-1 space-y-1">
									<p class="truncate font-medium text-slate-800 dark:text-slate-100">{tab.title || tab.url || 'Untitled'}</p>
									<p class="truncate text-xs text-slate-500 dark:text-slate-400">{tab.url || 'about:blank'}</p>
									<div class="flex flex-wrap items-center gap-1">
										<span
											class="rounded px-1.5 py-px text-3xs font-medium {tab.state === 'active'
												? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
												: 'bg-slate-500/10 text-slate-500 dark:text-slate-400'}"
										>
											{tab.state === 'active' ? 'Running' : 'Sleeping'}
										</span>
										{#if tab.watched}
											<span class="rounded bg-sky-500/10 px-1.5 py-px text-3xs font-medium text-sky-600 dark:text-sky-400">On screen</span>
										{/if}
										{#if tab.agentHeld}
											<span class="rounded bg-amber-500/10 px-1.5 py-px text-3xs font-medium text-amber-600 dark:text-amber-400">Agent working</span>
										{/if}
										<span class="rounded bg-slate-500/10 px-1.5 py-px text-3xs font-medium text-slate-500 dark:text-slate-400">
											Opened by {tab.openedBy === 'agent' ? 'agent' : 'you'}
										</span>
										{#if tab.dialog}
											<span class="rounded bg-red-500/10 px-1.5 py-px text-3xs font-medium text-red-600 dark:text-red-400">
												{tab.dialog.type} open
											</span>
										{/if}
									</div>
									<p class="text-xs text-slate-500 dark:text-slate-400">
										JS heap {bytes(tab.jsHeapUsedBytes)} · {tab.domNodes ?? '—'} DOM nodes · last used {ago(tab.lastAccessedAt)}
										{#if rates[tab.id]}
											· stream {rates[tab.id].fps} fps, {rates[tab.id].kbps} kbps
										{/if}
									</p>
								</div>
								<button
									type="button"
									onclick={() => closeTab(tab.id)}
									disabled={closing !== null || tab.agentHeld}
									class="shrink-0 rounded-md px-2 py-1 text-xs text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
									title={tab.agentHeld ? 'An agent is working in this tab' : 'Close this tab'}
								>
									{closing === tab.id ? 'Closing…' : 'Close'}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<p class="text-xs text-slate-400 dark:text-slate-500">
				A sleeping tab uses no CPU but keeps its memory until it is closed.
				{#if data.clipboard.length > 0}
					Shared clipboard: {data.clipboard.length} chars, last copied by
					{data.clipboard.source === 'device' ? 'your device' : data.clipboard.source === 'agent' ? 'the agent' : 'a page'}
					{ago(data.clipboard.updatedAt)}.
				{/if}
			</p>
		{/if}
	</div>
</Modal>
