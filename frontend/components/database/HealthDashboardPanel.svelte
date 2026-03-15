<script lang="ts">
	import { fade, scale } from 'svelte/transition';
	import { cubicOut } from 'svelte/easing';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbHealthState,
		closeHealthDashboard,
		fetchHealthMetrics,
		toggleAutoRefresh,
		computeAlerts
	} from '$frontend/stores/features/db-health.svelte';
	import type { DBHealthMetrics } from '$shared/types/db-health';
	import { HEALTH_THRESHOLDS } from '$shared/types/db-health';

	// ─── Derived values ────────────────────────────────────────────────────────

	const m = $derived(dbHealthState.current);
	const history = $derived(dbHealthState.history);
	const alerts = $derived(m ? computeAlerts(m) : []);
	const criticals = $derived(alerts.filter((a) => a.level === 'critical'));
	const warnings = $derived(alerts.filter((a) => a.level === 'warning'));

	const fetchedAtLabel = $derived(() => {
		if (!dbHealthState.fetchedAt) return '';
		return new Date(dbHealthState.fetchedAt).toLocaleTimeString();
	});

	// ─── Connections gauge ─────────────────────────────────────────────────────

	const mConnPct = $derived(() => {
		if (!m?.connections.max || m.connections.max <= 0) return 0;
		const total = m.connections.active + m.connections.idle + m.connections.waiting;
		return Math.min(100, (total / m.connections.max) * 100);
	});

	const mConnColor = $derived(() => {
		const pct = mConnPct();
		if (pct >= HEALTH_THRESHOLDS.connectionsPctCritical) return '#ef4444';
		if (pct >= HEALTH_THRESHOLDS.connectionsPctWarning) return '#f59e0b';
		return '#10b981';
	});

	function cacheColor(ratio: number): string {
		if (ratio < HEALTH_THRESHOLDS.cacheHitCritical) return 'text-red-500';
		if (ratio < HEALTH_THRESHOLDS.cacheHitWarning) return 'text-amber-500';
		return 'text-emerald-500';
	}

	// ─── SVG line chart ────────────────────────────────────────────────────────

	const CHART_W = 260;
	const CHART_H = 56;

	function buildLinePath(values: number[]): string {
		if (values.length < 2) return '';
		const max = Math.max(...values, 1);
		const pts = values.map((v, i) => {
			const x = (i / (values.length - 1)) * CHART_W;
			const y = CHART_H - (v / max) * (CHART_H - 4) - 2;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return `M ${pts.join(' L ')}`;
	}

	function buildAreaPath(values: number[]): string {
		if (values.length < 2) return '';
		const max = Math.max(...values, 1);
		const topPts = values.map((v, i) => {
			const x = (i / (values.length - 1)) * CHART_W;
			const y = CHART_H - (v / max) * (CHART_H - 4) - 2;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		return `M 0,${CHART_H} L ${topPts.join(' L ')} L ${CHART_W},${CHART_H} Z`;
	}

	const tpsHistory = $derived(history.map((h) => h.tps?.tps ?? 0));
	const connHistory = $derived(history.map((h) => h.connections.active));
	const memHistory = $derived(history.map((h) => h.memory?.usedMb ?? 0));
	const tpsPath = $derived(buildLinePath(tpsHistory));
	const tpsArea = $derived(buildAreaPath(tpsHistory));
	const connPath = $derived(buildLinePath(connHistory));
	const connArea = $derived(buildAreaPath(connHistory));
	const memPath = $derived(buildLinePath(memHistory));
	const memArea = $derived(buildAreaPath(memHistory));

	// Current TPS label
	const latestTps = $derived(tpsHistory.at(-1) ?? 0);
	const latestConns = $derived(m?.connections.active ?? 0);
	const latestMem = $derived(m?.memory?.usedMb ?? null);

	// ─── Bar chart for connections breakdown ───────────────────────────────────

	function pct(val: number, total: number): number {
		if (!total) return 0;
		return Math.min(100, Math.round((val / total) * 100));
	}

	// ─── Slow query helpers ────────────────────────────────────────────────────

	function formatDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
	}

	function truncate(s: string, n = 100): string {
		return s.length > n ? s.slice(0, n) + '…' : s;
	}
</script>

{#if dbHealthState.isOpen}
	<!-- Backdrop -->
	<div
		class="fixed inset-0 z-[110] flex items-center justify-center md:p-4 bg-black/60 backdrop-blur-sm"
		role="dialog"
		aria-modal="true"
		aria-label="Health Dashboard"
		tabindex="-1"
		onclick={(e) => { if (e.target === e.currentTarget) closeHealthDashboard(); }}
		onkeydown={(e) => { if (e.key === 'Escape') closeHealthDashboard(); }}
		in:fade={{ duration: 200, easing: cubicOut }}
		out:fade={{ duration: 150, easing: cubicOut }}
	>
		<!-- Panel -->
		<div
			class="flex flex-col w-full max-w-[1020px] h-[86dvh] max-h-[740px] bg-slate-50 dark:bg-slate-950 border border-violet-500/20 rounded-2xl overflow-hidden shadow-[0_25px_50px_-12px_rgba(0,0,0,0.4)] max-md:max-w-full max-md:h-dvh max-md:max-h-dvh max-md:rounded-none"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			in:scale={{ duration: 250, easing: cubicOut, start: 0.95 }}
			out:scale={{ duration: 150, easing: cubicOut, start: 0.95 }}
		>
			<!-- Header -->
			<header class="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/80 shrink-0">
				<div class="w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center shrink-0">
					<Icon name="lucide:heart-pulse" class="w-4 h-4 text-violet-600" />
				</div>
				<div class="flex-1 min-w-0">
					<h2 class="text-sm font-bold text-slate-900 dark:text-slate-100">Health Dashboard</h2>
					<p class="text-3xs text-slate-500 dark:text-slate-400">
						Real-time database performance metrics
						{#if dbHealthState.fetchedAt}
							· Last updated {fetchedAtLabel()}
						{/if}
					</p>
				</div>

				<!-- Alert badges -->
				{#if criticals.length > 0}
					<div class="flex items-center gap-1 px-2 py-1 rounded-md bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs font-medium">
						<Icon name="lucide:triangle-alert" class="w-3.5 h-3.5" />
						{criticals.length} critical
					</div>
				{/if}
				{#if warnings.length > 0}
					<div class="flex items-center gap-1 px-2 py-1 rounded-md bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400 text-xs font-medium">
						<Icon name="lucide:circle-alert" class="w-3.5 h-3.5" />
						{warnings.length} warning{warnings.length > 1 ? 's' : ''}
					</div>
				{/if}

				<!-- Toolbar -->
				<div class="flex items-center gap-1.5 shrink-0">
					<!-- Auto-refresh toggle -->
					<button
						type="button"
						class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all
							{dbHealthState.autoRefresh
								? 'bg-violet-600 border-violet-600 text-white'
								: 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}"
						onclick={toggleAutoRefresh}
						title={dbHealthState.autoRefresh ? 'Stop auto-refresh' : `Auto-refresh every ${dbHealthState.refreshIntervalSec}s`}
					>
						<Icon name="lucide:timer" class="w-3.5 h-3.5" />
						{dbHealthState.autoRefresh ? 'Live' : 'Auto'}
					</button>
					<!-- Manual refresh -->
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-lg border border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
						onclick={fetchHealthMetrics}
						disabled={dbHealthState.isLoading}
						title="Refresh now"
					>
						<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5 {dbHealthState.isLoading ? 'animate-spin' : ''}" />
					</button>
					<!-- Close -->
					<button
						type="button"
						class="flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-violet-500/10 transition-all"
						onclick={closeHealthDashboard}
						aria-label="Close"
					>
						<Icon name="lucide:x" class="w-4 h-4" />
					</button>
				</div>
			</header>

			<!-- Body -->
			<div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">

				{#if dbHealthState.isLoading && !m}
					<!-- Initial loading -->
					<div class="flex items-center justify-center h-40 gap-2 text-slate-400 text-sm">
						<svg class="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Collecting metrics…
					</div>

				{:else if m}
					<!-- ── Alert Banner ─────────────────────────────────────────────── -->
					{#if alerts.length > 0}
						<div class="flex flex-col gap-1.5">
							{#each alerts as alert (alert.metric + alert.level)}
								<div
									class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium
										{alert.level === 'critical'
											? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800/40'
											: 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800/40'}"
								>
									<Icon
										name={alert.level === 'critical' ? 'lucide:triangle-alert' : 'lucide:circle-alert'}
										class="w-4 h-4 shrink-0"
									/>
									{alert.message}
								</div>
							{/each}
						</div>
					{/if}

					<!-- ── Metric Cards Row ──────────────────────────────────────────── -->
					<div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
						<!-- Connections Card -->
						<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Connections</span>
								<Icon name="lucide:users" class="w-4 h-4 text-slate-400" />
							</div>
							<div class="text-2xl font-bold" style="color: {mConnColor()}">{latestConns}</div>
							<div class="text-3xs text-slate-400 dark:text-slate-500">
								{m.connections.idle} idle · {m.connections.waiting} waiting
								{#if m.connections.max}· max {m.connections.max}{/if}
							</div>
							{#if m.connections.max}
								<!-- Progress bar -->
								<div class="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
									<div
										class="h-full rounded-full transition-all duration-500"
										style="width: {mConnPct().toFixed(1)}%; background-color: {mConnColor()}"
									></div>
								</div>
								<div class="text-3xs" style="color: {mConnColor()}">{mConnPct().toFixed(0)}% used</div>
							{/if}
						</div>

						<!-- TPS Card -->
						<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">TPS</span>
								<Icon name="lucide:zap" class="w-4 h-4 text-slate-400" />
							</div>
							{#if m.tps !== null}
								<div class="text-2xl font-bold text-violet-600 dark:text-violet-400">{latestTps}</div>
								<div class="text-3xs text-slate-400">transactions/sec</div>
								<div class="text-3xs text-slate-400 dark:text-slate-500">
									{m.tps.commits.toLocaleString()} commits · {m.tps.rollbacks.toLocaleString()} rollbacks
								</div>
							{:else}
								<div class="text-sm text-slate-400 dark:text-slate-500 pt-1">Not available</div>
								<div class="text-3xs text-slate-400">for {m.dbType}</div>
							{/if}
						</div>

						<!-- Memory Card -->
						<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
							<div class="flex items-center justify-between">
								<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Memory</span>
								<Icon name="lucide:cpu" class="w-4 h-4 text-slate-400" />
							</div>
							{#if m.memory !== null}
								<div class="text-2xl font-bold text-blue-600 dark:text-blue-400">{(latestMem ?? 0).toFixed(1)}<span class="text-sm font-medium ml-1">MB</span></div>
								{#if m.memory.totalMb}
									<div class="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
										<div
											class="h-full rounded-full bg-blue-500 transition-all duration-500"
											style="width: {Math.min(100, ((latestMem ?? 0) / m.memory.totalMb) * 100).toFixed(1)}%"
										></div>
									</div>
									<div class="text-3xs text-slate-400 dark:text-slate-500">of {m.memory.totalMb.toFixed(1)} MB total</div>
								{:else}
									<div class="text-3xs text-slate-400">buffer pool used</div>
								{/if}
							{:else}
								<div class="text-sm text-slate-400 dark:text-slate-500 pt-1">Not available</div>
								<div class="text-3xs text-slate-400">for {m.dbType}</div>
							{/if}
						</div>

						<!-- Cache Hit / Disk Card -->
						<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-2">
							{#if m.memory?.cacheHitRatio !== null && m.memory?.cacheHitRatio !== undefined}
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Cache Hit</span>
									<Icon name="lucide:gauge" class="w-4 h-4 text-slate-400" />
								</div>
								<div class="text-2xl font-bold {cacheColor(m.memory.cacheHitRatio)}">{m.memory.cacheHitRatio.toFixed(1)}<span class="text-sm font-medium ml-0.5">%</span></div>
								<div class="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
									<div
										class="h-full rounded-full transition-all duration-500
											{m.memory.cacheHitRatio < HEALTH_THRESHOLDS.cacheHitCritical
												? 'bg-red-500'
												: m.memory.cacheHitRatio < HEALTH_THRESHOLDS.cacheHitWarning
													? 'bg-amber-500'
													: 'bg-emerald-500'}"
										style="width: {m.memory.cacheHitRatio.toFixed(1)}%"
									></div>
								</div>
								<div class="text-3xs text-slate-400">buffer cache effectiveness</div>
							{:else if m.disk !== null}
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Disk Size</span>
									<Icon name="lucide:hard-drive" class="w-4 h-4 text-slate-400" />
								</div>
								<div class="text-2xl font-bold text-slate-700 dark:text-slate-300">{m.disk.dbSizeMb.toFixed(1)}<span class="text-sm font-medium ml-1">MB</span></div>
								<div class="text-3xs text-slate-400">database file size</div>
							{:else}
								<div class="flex items-center justify-between">
									<span class="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Status</span>
									<Icon name="lucide:circle-check" class="w-4 h-4 text-slate-400" />
								</div>
								<div class="text-sm font-semibold text-emerald-500 dark:text-emerald-400 pt-1">Online</div>
								<div class="text-3xs text-slate-400">no issues detected</div>
							{/if}
						</div>
					</div>

					<!-- ── Charts Row ────────────────────────────────────────────────── -->
					{#if history.length >= 2}
						<div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
							<!-- TPS Line Chart -->
							{#if m.tps !== null}
								<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
									<div class="flex items-center justify-between mb-2">
										<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Transactions / sec</span>
										<span class="text-xs font-bold text-violet-600 dark:text-violet-400">{latestTps}</span>
									</div>
									<svg viewBox="0 0 {CHART_W} {CHART_H}" class="w-full" preserveAspectRatio="none">
										<!-- Area fill -->
										<path d={tpsArea} fill="rgb(139,92,246)" fill-opacity="0.12" />
										<!-- Line -->
										<path d={tpsPath} fill="none" stroke="rgb(139,92,246)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
									</svg>
									<div class="flex justify-between mt-1 text-3xs text-slate-400">
										<span>{history.length}s ago</span>
										<span>now</span>
									</div>
								</div>
							{/if}

							<!-- Active Connections Line Chart -->
							<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
								<div class="flex items-center justify-between mb-2">
									<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Active Connections</span>
									<span class="text-xs font-bold text-emerald-600 dark:text-emerald-400">{latestConns}</span>
								</div>
								<svg viewBox="0 0 {CHART_W} {CHART_H}" class="w-full" preserveAspectRatio="none">
									<path d={connArea} fill="rgb(16,185,129)" fill-opacity="0.12" />
									<path d={connPath} fill="none" stroke="rgb(16,185,129)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
								</svg>
								<div class="flex justify-between mt-1 text-3xs text-slate-400">
									<span>{history.length}s ago</span>
									<span>now</span>
								</div>
							</div>

							<!-- Memory Line Chart -->
							{#if m.memory !== null}
								<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
									<div class="flex items-center justify-between mb-2">
										<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Memory Usage (MB)</span>
										<span class="text-xs font-bold text-blue-600 dark:text-blue-400">{(latestMem ?? 0).toFixed(1)}</span>
									</div>
									<svg viewBox="0 0 {CHART_W} {CHART_H}" class="w-full" preserveAspectRatio="none">
										<path d={memArea} fill="rgb(59,130,246)" fill-opacity="0.12" />
										<path d={memPath} fill="none" stroke="rgb(59,130,246)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
									</svg>
									<div class="flex justify-between mt-1 text-3xs text-slate-400">
										<span>{history.length}s ago</span>
										<span>now</span>
									</div>
								</div>
							{/if}
						</div>
					{/if}

					<!-- ── Connections Breakdown Bar ─────────────────────────────────── -->
					{#if m.connections.max && m.connections.max > 0}
						{@const total = m.connections.active + m.connections.idle + m.connections.waiting}
						{@const activePct = pct(m.connections.active, m.connections.max)}
						{@const idlePct = pct(m.connections.idle, m.connections.max)}
						{@const waitPct = pct(m.connections.waiting, m.connections.max)}
						<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 p-3.5">
							<div class="flex items-center justify-between mb-3">
								<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">Connection Pool ({total} / {m.connections.max})</span>
							</div>
							<!-- Stacked bar -->
							<div class="w-full h-3 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-800 flex">
								<div class="h-full bg-emerald-500 transition-all duration-500" style="width: {activePct}%" title="Active: {m.connections.active}"></div>
								<div class="h-full bg-slate-300 dark:bg-slate-600 transition-all duration-500" style="width: {idlePct}%" title="Idle: {m.connections.idle}"></div>
								<div class="h-full bg-amber-400 transition-all duration-500" style="width: {waitPct}%" title="Waiting: {m.connections.waiting}"></div>
							</div>
							<div class="flex items-center gap-4 mt-2 text-3xs text-slate-500 dark:text-slate-400">
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>Active ({m.connections.active})</span>
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-600 inline-block"></span>Idle ({m.connections.idle})</span>
								<span class="flex items-center gap-1"><span class="w-2 h-2 rounded-full bg-amber-400 inline-block"></span>Waiting ({m.connections.waiting})</span>
							</div>
						</div>
					{/if}

					<!-- ── Slow Queries Table ─────────────────────────────────────────── -->
					<div class="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden">
						<div class="flex items-center gap-2 px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800">
							<Icon name="lucide:clock-alert" class="w-4 h-4 text-amber-500" />
							<span class="text-xs font-semibold text-slate-600 dark:text-slate-400">
								Slow Queries
								<span class="text-3xs text-slate-400 dark:text-slate-500 ml-1">(>&nbsp;{HEALTH_THRESHOLDS.slowQueryThresholdMs / 1000}s)</span>
							</span>
							{#if m.slowQueries.length > 0}
								<span class="ml-auto px-1.5 py-0.5 text-3xs font-bold bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-full">
									{m.slowQueries.length}
								</span>
							{/if}
						</div>

						{#if m.slowQueries.length === 0}
							<div class="flex items-center justify-center gap-2 py-6 text-slate-400 text-xs">
								<Icon name="lucide:circle-check" class="w-4 h-4 text-emerald-500" />
								No slow queries detected
							</div>
						{:else}
							<div class="overflow-auto max-h-52">
								<table class="min-w-full text-xs border-separate border-spacing-0">
									<thead class="sticky top-0 z-10">
										<tr>
											<th class="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
												Duration
											</th>
											<th class="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 whitespace-nowrap">
												User / DB
											</th>
											<th class="px-3 py-2 text-left font-semibold text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700">
												Query
											</th>
										</tr>
									</thead>
									<tbody>
										{#each m.slowQueries as sq, i (i)}
											<tr class="hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors">
												<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 whitespace-nowrap">
													<span class="font-semibold text-red-600 dark:text-red-400">{formatDuration(sq.durationMs)}</span>
												</td>
												<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 whitespace-nowrap text-slate-500 dark:text-slate-400">
													{sq.user ?? '—'}
													{#if sq.database}
														<span class="block text-3xs">{sq.database}</span>
													{/if}
												</td>
												<td class="px-3 py-2 border-b border-slate-100 dark:border-slate-800 max-w-xs">
													<span class="font-mono text-slate-700 dark:text-slate-300 block truncate" title={sq.query}>
														{truncate(sq.query)}
													</span>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/if}
					</div>
				{/if}
			</div>

			<!-- Status bar -->
			<div class="flex items-center gap-3 px-4 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 shrink-0 text-3xs text-slate-400">
				<span>{m?.dbType ?? '—'}</span>
				{#if dbHealthState.autoRefresh}
					<span class="flex items-center gap-1 text-violet-500">
						<span class="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse"></span>
						Live — every {dbHealthState.refreshIntervalSec}s
					</span>
				{/if}
				{#if dbHealthState.isLoading && m}
					<span class="flex items-center gap-1">
						<svg class="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
							<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
							<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
						</svg>
						Refreshing…
					</span>
				{/if}
				<span class="ml-auto">{history.length} data points collected</span>
			</div>
		</div>
	</div>
{/if}
