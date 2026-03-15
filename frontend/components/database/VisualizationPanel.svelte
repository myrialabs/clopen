<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import Icon from '$frontend/components/common/display/Icon.svelte';
	import {
		dbVizState,
		initVizColumns,
		toggleYColumn,
		saveChartToDashboard,
		removeDashboardItem,
		loadDashboardItem,
		refetchLive,
	} from '$frontend/stores/features/db-visualization.svelte';
	import { themeStore } from '$frontend/stores/ui/theme.svelte';
	import { addNotification } from '$frontend/stores/ui/notification.svelte';
	import type { DBQueryResult } from '$shared/types/db-manager';
	import type { ChartType, DashboardItem } from '$shared/types/db-visualization';
	import type { IconName } from '$shared/types/ui/icons';

	interface Props {
		result: DBQueryResult | null;
		sql?: string;
	}

	const { result, sql }: Props = $props();

	// ─── Chart instance ──────────────────────────────────────────────────────
	let canvasEl = $state<HTMLCanvasElement | null>(null);
	let chartInstance: any = null;
	let ChartLib: any = null;
	let isChartReady = $state(false);

	// ─── Chart type options ──────────────────────────────────────────────────
	const CHART_TYPES: { value: ChartType; label: string; icon: IconName }[] = [
		{ value: 'bar',  label: 'Bar',  icon: 'lucide:bar-chart-3' },
		{ value: 'line', label: 'Line', icon: 'lucide:trending-up' },
		{ value: 'area', label: 'Area', icon: 'lucide:activity'    },
		{ value: 'pie',  label: 'Pie',  icon: 'lucide:pie-chart'   },
	];

	const CHART_TYPE_ICONS: Record<ChartType, IconName> = {
		bar:  'lucide:bar-chart-3',
		line: 'lucide:trending-up',
		area: 'lucide:activity',
		pie:  'lucide:pie-chart',
	};

	const PALETTE = [
		'#7c3aed', '#10b981', '#f59e0b', '#3b82f6', '#ef4444',
		'#8b5cf6', '#14b8a6', '#f97316', '#06b6d4', '#ec4899',
	];

	// ─── Effective data: snapshot takes priority over live result ────────────
	//
	//  When a dashboard item is loaded, activeSnapshot holds its saved rows/cols
	//  so the chart always renders what the user saved — independent of whatever
	//  the current live query result happens to be.
	//  activeSnapshot is cleared automatically when the user runs a new query
	//  (result reference changes) via the effect below.
	//
	const effectiveColumns = $derived(
		dbVizState.activeSnapshot?.columns ?? result?.columns ?? [],
	);
	const effectiveRows = $derived(
		dbVizState.activeSnapshot?.rows ?? result?.rows ?? [],
	);
	const hasData         = $derived(effectiveColumns.length > 0 && effectiveRows.length > 0);
	const isShowingSnap   = $derived(dbVizState.activeSnapshot !== null);

	// ─── Auto-clear snapshot when a new query is executed ───────────────────
	//  We track `result` (the live DBQueryResult reference). When it changes to
	//  a new object (new query ran), we check for schema divergence, notify the
	//  user if the columns changed significantly, then discard the snapshot.
	$effect(() => {
		const liveResult = result; // tracked
		untrack(() => {
			if (liveResult !== null && dbVizState.activeSnapshot !== null) {
				if (hasSchemaDivergence(liveResult.columns, dbVizState.activeSnapshot.columns)) {
					addNotification({
						type: 'warning',
						title: 'Visualization — schema changed',
						message:
							'The new query result has significantly different columns from the active snapshot. ' +
							'Refresh the snapshot or reconfigure the chart axes.',
						duration: 7000,
					});
				}
				dbVizState.activeSnapshot = null;
				dbVizState.snapshotFetchedAt = null;
				dbVizState.snapshotSql = null;
				dbVizState.snapshotConnectionId = null;
			}
		});
	});

	// ─── Init effect: set default column selections ──────────────────────────
	//  Runs when effectiveColumns changes (new query result OR new snapshot
	//  loaded). Wrapped in untrack so reads inside initVizColumns do NOT
	//  become deps — which would create an infinite reactive loop.
	//  Skipped entirely while a snapshot is active because loadDashboardItem
	//  already set the correct xColumn / yColumns.
	$effect(() => {
		const cols = effectiveColumns; // tracked
		untrack(() => {
			if (cols.length && !dbVizState.activeSnapshot) {
				initVizColumns(cols);
			}
		});
	});

	// ─── Chart.js lazy load ──────────────────────────────────────────────────
	onMount(async () => {
		const mod = await import('chart.js');
		mod.Chart.register(...mod.registerables);
		ChartLib = mod;
		isChartReady = true;
	});

	// ─── Main render effect ──────────────────────────────────────────────────
	//  Lists ONLY the deps that should trigger a full chart rebuild.
	//  renderChart() is called inside untrack() so any extra reactive reads
	//  inside buildChartConfig() (e.g. effectiveRows items) don't leak back
	//  as additional deps and cause runaway re-renders.
	$effect(() => {
		const type = dbVizState.chartType;
		const x    = dbVizState.xColumn;
		const y    = dbVizState.yColumns.join(',');
		const snap = dbVizState.activeSnapshot;  // triggers re-render on load/clear
		const res  = result;
		const ready = isChartReady;
		const cvs  = canvasEl;
		const dark = themeStore.isDark;

		if (!ready || !cvs) return;
		void [type, x, y, snap, res, dark]; // reference vars to satisfy TS

		untrack(() => renderChart());
	});

	// ─── Title-only update (no chart rebuild) ────────────────────────────────
	//  Typing in the Title field updates the chart label in-place via
	//  Chart.js update('none'), avoiding a destroy+recreate on every keystroke.
	$effect(() => {
		const title = dbVizState.chartTitle;
		untrack(() => applyTitle(title));
	});

	onDestroy(() => {
		try { chartInstance?.destroy(); } catch { /* ignore */ }
		// Free snapshot memory when the panel is closed or the user switches away
		dbVizState.activeSnapshot = null;
		dbVizState.snapshotFetchedAt = null;
		dbVizState.snapshotSql = null;
		dbVizState.snapshotConnectionId = null;
	});

	// ─── Schema divergence helper ─────────────────────────────────────────────
	//  Returns true when more than half of the snapshot's columns are absent in
	//  the new live result — a sign that the query has significantly changed.
	function hasSchemaDivergence(liveColumns: string[], snapColumns: string[]): boolean {
		if (!snapColumns.length || !liveColumns.length) return false;
		const liveSet = new Set(liveColumns);
		const missing = snapColumns.filter((c) => !liveSet.has(c)).length;
		return missing / snapColumns.length > 0.5;
	}

	// ─── SWR timestamp helper ─────────────────────────────────────────────────
	function formatSnapshotAge(iso: string | null): string {
		if (!iso) return '';
		const diff = Date.now() - new Date(iso).getTime();
		const mins = Math.floor(diff / 60000);
		if (mins < 1) return 'just now';
		if (mins < 60) return `${mins}m ago`;
		const hrs = Math.floor(mins / 60);
		if (hrs < 24) return `${hrs}h ago`;
		return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
	}

	// ─── Chart helpers ────────────────────────────────────────────────────────

	function buildChartConfig(
		title: string,
		cols: string[],
		dataRows: Record<string, unknown>[],
	) {
		if (!cols.length || !dataRows.length) return null;
		if (!dbVizState.xColumn || !cols.includes(dbVizState.xColumn)) return null;

		const validY = dbVizState.yColumns.filter((c) => cols.includes(c));
		if (!validY.length) return null;

		const dark       = themeStore.isDark;
		const labelColor = dark ? '#94a3b8' : '#475569';
		const gridColor  = dark ? '#1e293b' : '#e2e8f0';
		const titleColor = dark ? '#e2e8f0' : '#1e293b';

		const labels = dataRows.map((r) => String(r[dbVizState.xColumn] ?? ''));
		const isPie  = dbVizState.chartType === 'pie';
		const isArea = dbVizState.chartType === 'area';
		const jsType = isPie ? 'pie' : isArea ? 'line' : dbVizState.chartType;

		const datasets = (isPie ? [validY[0]] : validY).map((col, i) => {
			const data = dataRows.map((r) => {
				const val = r[col];
				if (typeof val === 'number') return val;
				const n = Number(val);
				return isNaN(n) ? 0 : n;
			});

			if (isPie) {
				return {
					label: col,
					data,
					backgroundColor: PALETTE.slice(0, data.length).map((c) => `${c}cc`),
					borderColor: dark ? '#0f172a' : '#ffffff',
					borderWidth: 2,
				};
			}

			const color = PALETTE[i % PALETTE.length];
			return {
				label: col,
				data,
				backgroundColor: `${color}44`,
				borderColor: color,
				borderWidth: 2,
				fill: isArea,
				tension: 0.35,
				pointRadius: data.length > 80 ? 0 : 3,
				pointHoverRadius: 5,
			};
		});

		return {
			type: jsType,
			data: { labels, datasets },
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: { duration: 250 },
				plugins: {
					legend: {
						display: true,
						labels: { color: labelColor, font: { size: 11 }, padding: 16 },
					},
					title: {
						display: !!title,
						text: title,
						color: titleColor,
						font: { size: 13, weight: 'bold' as const },
						padding: { bottom: 12 },
					},
					tooltip: { mode: 'index' as const, intersect: false },
				},
				scales: !isPie
					? {
							x: {
								ticks: { color: labelColor, font: { size: 10 }, maxTicksLimit: 20, maxRotation: 45 },
								grid: { color: gridColor },
							},
							y: {
								beginAtZero: true,
								ticks: { color: labelColor, font: { size: 10 } },
								grid: { color: gridColor },
							},
						}
					: undefined,
			},
		};
	}

	function renderChart() {
		if (!canvasEl || !ChartLib) return;

		try { chartInstance?.destroy(); } catch { /* ignore */ }
		chartInstance = null;

		// Clear canvas to avoid ghost artifacts
		const ctx = canvasEl.getContext('2d');
		if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

		// Use snapshot data if available, otherwise live result
		const cols = effectiveColumns;
		const rows = effectiveRows;

		const config = buildChartConfig(dbVizState.chartTitle, cols, rows);
		if (!config) return;

		try {
			chartInstance = new ChartLib.Chart(canvasEl, config);
		} catch { /* canvas may be in bad state — next render will recover */ }
	}

	function applyTitle(title: string) {
		if (!chartInstance) return;
		try {
			chartInstance.options.plugins.title.text = title;
			chartInstance.options.plugins.title.display = !!title;
			chartInstance.update('none');
		} catch { /* ignore stale instance */ }
	}

	// ─── Snapshot clear ───────────────────────────────────────────
	function clearSnapshot() {
		dbVizState.activeSnapshot = null;
		dbVizState.snapshotFetchedAt = null;
		dbVizState.snapshotSql = null;
		dbVizState.snapshotConnectionId = null;
	}

	// ─── Y-axis toggle ────────────────────────────────────────────────────────
	function handleYToggle(col: string) {
		if (dbVizState.chartType === 'pie') {
			dbVizState.yColumns = [col];
		} else {
			toggleYColumn(col);
		}
	}

	// ─── Dashboard helpers ────────────────────────────────────────────────────
	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short', day: 'numeric', year: 'numeric',
		});
	}
</script>

{#if dbVizState.showDashboard}
	<!-- ─── Dashboard view ──────────────────────────────────────────────────── -->
	<div class="flex flex-col h-full min-h-0">
		<div class="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
			<button
				type="button"
				class="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
				onclick={() => (dbVizState.showDashboard = false)}
			>
				<Icon name="lucide:arrow-left" class="w-3.5 h-3.5" />
				Back
			</button>
			<Icon name="lucide:layout-dashboard" class="w-3.5 h-3.5 text-violet-500" />
			<span class="text-xs font-semibold text-slate-700 dark:text-slate-300">Saved Charts</span>
			{#if dbVizState.dashboard.length > 0}
				<span class="text-xs text-slate-400">({dbVizState.dashboard.length})</span>
			{/if}
		</div>

		<div class="flex-1 min-h-0 overflow-y-auto p-3">
			{#if dbVizState.dashboard.length === 0}
				<div class="flex flex-col items-center justify-center h-full gap-2 text-slate-400 text-xs">
					<Icon name="lucide:layout-dashboard" class="w-8 h-8 opacity-30" />
					<span>No saved charts yet</span>
					<span class="text-slate-300 dark:text-slate-600">Configure a chart and click "Save to Dashboard"</span>
				</div>
			{:else}
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{#each dbVizState.dashboard as item (item.id)}
						<div class="flex flex-col gap-2.5 p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-violet-300 dark:hover:border-violet-700 transition-colors">
							<div class="flex items-start justify-between gap-2">
								<div class="flex items-center gap-2 min-w-0">
									<div class="shrink-0 w-7 h-7 rounded-md bg-violet-100 dark:bg-violet-900/30 flex items-center justify-center text-violet-600 dark:text-violet-400">
										<Icon name={CHART_TYPE_ICONS[item.chartConfig.chartType]} class="w-4 h-4" />
									</div>
									<div class="min-w-0">
										<p class="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate" title={item.chartConfig.name}>
											{item.chartConfig.name}
										</p>
										<p class="text-[10px] text-slate-400 capitalize">{item.chartConfig.chartType} chart</p>
									</div>
								</div>
								<button
									type="button"
									class="shrink-0 p-1 rounded text-slate-400 hover:text-red-500 transition-colors"
									onclick={() => removeDashboardItem(item.id)}
									title="Remove from dashboard"
								>
									<Icon name="lucide:trash-2" class="w-3.5 h-3.5" />
								</button>
							</div>

							<div class="flex flex-col gap-1 text-[10px] text-slate-500 dark:text-slate-400">
								<div class="flex items-center gap-1.5">
									<span class="font-semibold text-slate-600 dark:text-slate-400">X:</span>
									<span class="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{item.chartConfig.xColumn}</span>
								</div>
								<div class="flex items-center gap-1.5 flex-wrap">
									<span class="font-semibold text-slate-600 dark:text-slate-400">Y:</span>
									{#each item.chartConfig.yColumns as col}
										<span class="font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded">{col}</span>
									{/each}
								</div>
								<div class="flex items-center gap-1 text-slate-400 dark:text-slate-600 mt-0.5">
									<Icon name="lucide:calendar" class="w-3 h-3" />
									<span>{formatDate(item.createdAt)}</span>
									<span class="ml-auto text-[9px]">{item.snapshotData.rows.length} rows</span>
								</div>
							</div>

							<button
								type="button"
								class="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white transition-colors"
								onclick={() => loadDashboardItem(item)}
							>
								<Icon name="lucide:bar-chart-3" class="w-3.5 h-3.5" />
								Load Chart
							</button>
						</div>
					{/each}
				</div>
			{/if}
		</div>
	</div>
{:else}
	<!-- ─── Visualization view ──────────────────────────────────────────────── -->
	<div class="flex flex-col h-full min-h-0">
		<!-- Top bar: chart type + dashboard toggle -->
		<div class="flex items-center gap-1 px-2 py-1.5 border-b border-slate-200 dark:border-slate-800 shrink-0 flex-wrap">
			<span class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mr-1">Type</span>
			{#each CHART_TYPES as ct}
				<button
					type="button"
					class="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all
						{dbVizState.chartType === ct.value
							? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border border-violet-300 dark:border-violet-700'
							: 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 border border-transparent'}"
					onclick={() => (dbVizState.chartType = ct.value)}
				>
					<Icon name={ct.icon} class="w-3 h-3" />
					{ct.label}
				</button>
			{/each}

			<div class="flex-1"></div>

			<button
				type="button"
				class="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-violet-400 dark:hover:border-violet-600 hover:text-violet-600 dark:hover:text-violet-400 transition-colors"
				onclick={() => (dbVizState.showDashboard = true)}
			>
				<Icon name="lucide:layout-dashboard" class="w-3.5 h-3.5" />
				Dashboard
				{#if dbVizState.dashboard.length > 0}
					<span class="flex items-center justify-center w-4 h-4 rounded-full bg-violet-600 text-white text-[10px] font-bold">
						{dbVizState.dashboard.length}
					</span>
				{/if}
			</button>
		</div>

		<!-- Body -->
		{#if !hasData}
			<div class="flex flex-col items-center justify-center flex-1 gap-2 text-slate-400 text-xs">
				<Icon name="lucide:bar-chart-3" class="w-8 h-8 opacity-30" />
				<span>Run a SELECT query to visualize results</span>
			</div>
		{:else}
			<div class="flex flex-1 min-h-0">
				<!-- Controls sidebar -->
				<div class="w-44 shrink-0 flex flex-col gap-3 p-3 border-r border-slate-200 dark:border-slate-800 overflow-y-auto">

					<!-- Snapshot indicator (Stale-While-Revalidate banner) -->
					{#if isShowingSnap}
						<div class="flex items-center gap-1 px-2 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-400">
							<Icon name="lucide:bookmark" class="w-3 h-3 shrink-0" />
							<div class="flex flex-col flex-1 min-w-0 ml-1">
								<span class="font-medium leading-tight">Snapshot</span>
								<span class="opacity-60 leading-tight truncate">
									{#if !dbVizState.snapshotFetchedAt}
										Refreshing...
									{:else}
										{formatSnapshotAge(dbVizState.snapshotFetchedAt)}
									{/if}
								</span>
							</div>
							<!-- Re-run snapshot SQL -->
							<button
								type="button"
								class="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
								onclick={() => void refetchLive()}
								title="Re-run snapshot query to get latest data"
							>
								<Icon name="lucide:refresh-cw" class="w-3 h-3" />
							</button>
							<!-- Dismiss -->
							<button
								type="button"
								class="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
								onclick={clearSnapshot}
								title="Switch to live query data"
							>
								<Icon name="lucide:x" class="w-3 h-3" />
							</button>
						</div>
					{/if}

					<!-- X Axis — use value + onchange instead of bind:value to avoid
					     two-way binding writing blank back when options change -->
					<div class="flex flex-col gap-1.5">
						<label class="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">X Axis</label>
						<select
							class="w-full px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-violet-500"
							value={dbVizState.xColumn}
							onchange={(e) => (dbVizState.xColumn = (e.currentTarget as HTMLSelectElement).value)}
						>
							{#each effectiveColumns as col}
								<option value={col} selected={col === dbVizState.xColumn}>{col}</option>
							{/each}
						</select>
					</div>

					<!-- Y Axis -->
					<div class="flex flex-col gap-1.5">
						<label class="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">
							Y Axis{dbVizState.chartType !== 'pie' ? ' (multi)' : ''}
						</label>
						<div class="flex flex-col gap-0.5 max-h-36 overflow-y-auto">
							{#each effectiveColumns as col}
								{@const isSelected = dbVizState.yColumns.includes(col)}
								<label class="flex items-center gap-2 cursor-pointer px-1.5 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
									<input
										type={dbVizState.chartType === 'pie' ? 'radio' : 'checkbox'}
										name={dbVizState.chartType === 'pie' ? 'viz-y-pie' : undefined}
										class="w-3 h-3 accent-violet-600 shrink-0"
										checked={isSelected}
										onchange={() => handleYToggle(col)}
									/>
									<span class="text-[11px] text-slate-600 dark:text-slate-400 truncate" title={col}>{col}</span>
								</label>
							{/each}
						</div>
					</div>

					<!-- Title -->
					<div class="flex flex-col gap-1.5">
						<label class="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Title</label>
						<input
							type="text"
							class="w-full px-2 py-1 rounded-md text-xs bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-violet-500"
							placeholder="Optional..."
							bind:value={dbVizState.chartTitle}
						/>
					</div>

					<p class="text-[10px] text-slate-400 dark:text-slate-600">
						{effectiveRows.length.toLocaleString()} rows plotted
					</p>

					<button
						type="button"
						class="flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 disabled:bg-violet-600/50 disabled:cursor-not-allowed text-white transition-colors mt-auto"
						onclick={() => saveChartToDashboard(sql, dbVizState.activeSnapshot ?? undefined)}
						disabled={!dbVizState.xColumn || !dbVizState.yColumns.length}
					>
						<Icon name="lucide:bookmark-plus" class="w-3.5 h-3.5" />
						Save to Dashboard
					</button>
				</div>

				<!-- Chart canvas -->
				<div class="flex-1 min-w-0 relative p-3">
					{#if !isChartReady}
						<div class="flex items-center justify-center h-full gap-2 text-slate-400 text-xs">
							<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
							</svg>
							Loading chart library...
						</div>
					{:else}
						<canvas bind:this={canvasEl} class="w-full h-full"></canvas>
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}
