<script module lang="ts">
	import wsPrefetch from '$frontend/utils/ws';
	import { debug as debugPrefetch } from '$shared/utils/logger';

	// Module-level cache: persists across tab switches so Device opens instantly
	// on second click without re-showing skeleton.
	export let cachedDeviceInfo: any = null;
	// Same idea for the Project Overview snapshot below: opening Device a
	// second time shows the last recap instantly while a refresh runs behind.
	export let cachedOverview: any = null;

	// Shared in-flight guards so a prefetch started when the Settings modal
	// opens is joined (not duplicated) by the component mount below. This is
	// what makes the FIRST click instant: the slow si.* probes + folder walks
	// already run while the user is still looking at other tabs.
	let inFlightDevice: Promise<any> | null = null;
	let inFlightOverview: Promise<any> | null = null;

	/** Warm the Device cache in background; safe to call repeatedly. */
	export function prefetchDeviceInfo(): Promise<any> | null {
		if (cachedDeviceInfo || inFlightDevice) return inFlightDevice;
		inFlightDevice = wsPrefetch
			.http('system:device-info', {}, 8000)
			.then((data) => {
				cachedDeviceInfo = data;
				return data;
			})
			.catch((err) => {
				debugPrefetch.error('settings', 'Failed to prefetch device info:', err);
				return null;
			})
			.finally(() => {
				inFlightDevice = null;
			});
		return inFlightDevice;
	}

	/** Warm the Project Overview cache in background; safe to call repeatedly. */
	export function prefetchProjectsOverview(): Promise<any> | null {
		if (cachedOverview || inFlightOverview) return inFlightOverview;
		inFlightOverview = wsPrefetch
			.http('projects:overview', {}, 30000)
			.then((data) => {
				cachedOverview = data;
				return data;
			})
			.catch((err) => {
				debugPrefetch.error('settings', 'Failed to prefetch projects overview:', err);
				return null;
			})
			.finally(() => {
				inFlightOverview = null;
			});
		return inFlightOverview;
	}

	/** Join an in-flight prefetch so mount never fires a duplicate request. */
	export function joinDevicePrefetch(): Promise<any> | null {
		return inFlightDevice;
	}

	export function joinOverviewPrefetch(): Promise<any> | null {
		return inFlightOverview;
	}
</script>

<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import Icon from '../../common/display/Icon.svelte';
	import ws from '$frontend/utils/ws';
	import { debug } from '$shared/utils/logger';

	interface Gpu {
		model: string;
		vendor: string;
		vramMb: number | null;
		utilizationGpu: number | null;
		memoryUsedMb: number | null;
		memoryTotalMb: number | null;
	}
	interface Disk {
		mount: string;
		type: string;
		sizeBytes: number;
		usedBytes: number;
		usePercent: number;
	}
	interface DeviceInfo {
		hostname: string;
		platform: string;
		distro: string;
		release: string;
		kernel: string;
		arch: string;
		isVirtual: boolean;
		uptimeSec: number;
		cpu: {
			brand: string;
			manufacturer: string;
			physicalCores: number;
			logicalCores: number;
			speedGhz: number | null;
			loadPercent: number;
			loadAvg1: number | null;
		};
		memory: {
			totalBytes: number;
			usedBytes: number;
			freeBytes: number;
			swapTotalBytes: number;
			swapUsedBytes: number;
		};
		network: { iface: string; ip4: string; mac: string };
		battery: {
			hasBattery: boolean;
			percent: number | null;
			isCharging: boolean;
			acConnected: boolean;
			timeRemainingMinutes: number | null;
		};
		gpus: Gpu[];
		disks: Disk[];
	}

	// Single 3s refresh heartbeat for the whole panel: device cards and
	// Project Overview (counts, statuses, Top Projects) update together.
	// Cheap per tick: device probes are cached/single-flighted, folder walks
	// keep their own cache, and the overview snapshot has a matching 3s TTL.
	const REFRESH_INTERVAL_MS = 3000;

	let info = $state<DeviceInfo | null>(cachedDeviceInfo as DeviceInfo | null);
	let error = $state<string | null>(null);
	let timer: ReturnType<typeof setTimeout> | null = null;
	let fetching = false;

	async function fetchInfo() {
		if (fetching) return;
		// Join a prefetch started when the Settings modal opened instead of
		// firing a duplicate slow request — first click feels instant.
		const joined = joinDevicePrefetch();
		if (joined) {
			fetching = true;
			try {
				const data = await joined;
				if (data) {
					info = data as DeviceInfo;
					error = null;
				}
			} catch (err) {
				debug.error('settings', 'Failed to fetch device info:', err);
				if (!info) error = err instanceof Error ? err.message : 'Failed to load device information';
			} finally {
				fetching = false;
			}
			return;
		}
		fetching = true;
		try {
			// 8s client timeout — shorter than ws default 30s so UI recovers faster
			const data = await ws.http('system:device-info', {}, 8000);
			info = data as DeviceInfo;
			cachedDeviceInfo = info;
			error = null;
		} catch (err) {
			debug.error('settings', 'Failed to fetch device info:', err);
			// Keep stale info visible; only show error if we have no data yet
			if (!info) error = err instanceof Error ? err.message : 'Failed to load device information';
		} finally {
			fetching = false;
		}
	}

	// --- Project Overview (independent from the Device poll above) ---
	interface OverviewTopEntry {
		id: string;
		name: string;
		path: string;
		created_at: string;
		last_opened_at: string;
		status: 'running' | 'idle';
		cpuPercent: number | null;
		memRssBytes: number | null;
		memPercent: number | null;
		sizeBytes: number;
		fileCount: number;
		dirCount: number;
		truncated: boolean;
	}
	interface OverviewUnmeasurable {
		id: string;
		name: string;
		path: string;
		error: string;
	}
	interface ProjectsOverview {
		totalProjects: number;
		runningCount: number;
		idleCount: number;
		measurableCount: number;
		unmeasurableCount: number;
		totalStorageIdle: number;
		totalFilesIdle: number;
		totalDirsIdle: number;
		top: OverviewTopEntry[];
		unmeasurable: OverviewUnmeasurable[];
		generatedAt: string;
	}

	let overview = $state<ProjectsOverview | null>(cachedOverview as ProjectsOverview | null);
	let overviewError = $state<string | null>(null);
	let overviewFetching = $state(false);

	// View-only search over the Top Projects list (name + path). Data untouched.
	let topSearch = $state('');
	const filteredTop = $derived.by(() => {
		const list = overview?.top ?? [];
		const query = topSearch.trim().toLowerCase();
		if (!query) return list;
		return list.filter(
			(entry) =>
				entry.name.toLowerCase().includes(query) || entry.path.toLowerCase().includes(query)
		);
	});

	async function fetchOverview() {
		if (overviewFetching) return;
		// Same join-prefetch idea as Device above: the overview folder walk
		// already runs in background since the modal opened.
		const joined = joinOverviewPrefetch();
		if (joined) {
			overviewFetching = true;
			try {
				const data = await joined;
				if (data) {
					overview = data as ProjectsOverview;
					overviewError = null;
				}
			} catch (err) {
				debug.error('settings', 'Failed to fetch projects overview:', err);
				if (!overview) overviewError = err instanceof Error ? err.message : 'Failed to load project overview';
			} finally {
				overviewFetching = false;
			}
			return;
		}
		overviewFetching = true;
	try {
		// Generous timeout: the first call can walk several project folders
		// plus one process-table probe concurrently (worst ~20s+overhead).
		const data = await ws.http('projects:overview', {}, 30000);
		overview = data as ProjectsOverview;
		cachedOverview = overview;
		overviewError = null;
	} catch (err) {
		debug.error('settings', 'Failed to fetch projects overview:', err);
		// Keep the stale recap visible; only show an error with no data yet.
		// The Device cards above are untouched by this failure.
		if (!overview) overviewError = err instanceof Error ? err.message : 'Failed to load project overview';
	} finally {
		overviewFetching = false;
	}
	}

	// Single heartbeat: both fetches run concurrently on one fixed 3s
	// interval. In-flight guards inside each fetch skip a tick while the
	// previous one is still running, so slow folder walks can never pile up.
	// The keyed list + untouched search input mean no scroll or focus jumps.
	async function refreshAll() {
		await Promise.all([fetchInfo(), fetchOverview()]);
	}

	onMount(() => {
		// If cached data exists, show it instantly and refresh in background.
		// Otherwise fetch immediately.
		refreshAll();
		if (timer) clearInterval(timer);
		timer = setInterval(refreshAll, REFRESH_INTERVAL_MS);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});

	// --- Formatting helpers ---
	function fmtBytes(bytes: number): string {
		if (!bytes || bytes < 0) return '0 B';
		const k = 1024;
		const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
		const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
		return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
	}

	// Compact counts for the Top Projects dashboard cards: 3797 → "3.8K".
	function fmtCompact(n: number): string {
		if (!Number.isFinite(n) || n < 0) return '0';
		if (n < 1000) return n.toLocaleString();
		const units = ['K', 'M', 'B'];
		let value = n;
		let unit = '';
		for (const u of units) {
			value /= 1000;
			unit = u;
			if (value < 1000) break;
		}
		return `${parseFloat(value.toFixed(1))}${unit}`;
	}

	function fmtUptime(sec: number): string {
		const d = Math.floor(sec / 86400);
		const h = Math.floor((sec % 86400) / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const parts: string[] = [];
		if (d) parts.push(`${d}d`);
		if (h) parts.push(`${h}h`);
		parts.push(`${m}m`);
		return parts.join(' ');
	}

	function barColor(pct: number): string {
		if (pct >= 90) return 'bg-red-500';
		if (pct >= 75) return 'bg-amber-500';
		return 'bg-violet-500';
	}

	function fmtDate(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '—';
		return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	}

	// Same unit Project Info reasons about: null means the host table could
	// not be read yet (measuring), not zero.
	function fmtCpu(value: number | null): string {
		if (value === null) return '—';
		if (value === 0) return '0%';
		if (value < 0.1) return '<0.1%';
		return `${value.toFixed(1)}%`;
	}

	function fmtRelative(iso: string): string {
		const t = new Date(iso).getTime();
		if (Number.isNaN(t)) return '—';
		const diffMin = Math.max(0, Math.floor((Date.now() - t) / 60000));
		if (diffMin < 1) return 'just now';
		if (diffMin < 60) return `${diffMin}m ago`;
		const diffH = Math.floor(diffMin / 60);
		if (diffH < 24) return `${diffH}h ago`;
		const diffD = Math.floor(diffH / 24);
		if (diffD < 30) return `${diffD}d ago`;
		const diffMo = Math.floor(diffD / 30);
		if (diffMo < 12) return `${diffMo}mo ago`;
		return fmtDate(iso);
	}

	// --- Derived presentation ---
	const isServer = $derived(info ? info.isVirtual || !info.battery.hasBattery : false);
	const title = $derived(isServer ? 'Server' : 'This Device');
	const subtitle = $derived(
		isServer
			? 'Hardware and live status of the machine running clopen'
			: 'Hardware and live status of this device'
	);

	const memPercent = $derived(
		info && info.memory.totalBytes > 0
			? (info.memory.usedBytes / info.memory.totalBytes) * 100
			: 0
	);
	const swapPercent = $derived(
		info && info.memory.swapTotalBytes > 0
			? (info.memory.swapUsedBytes / info.memory.swapTotalBytes) * 100
			: 0
	);

	const osLabel = $derived(
		info ? [info.distro, info.release].filter(Boolean).join(' ') || info.platform : ''
	);

	// When the number of variable cards (GPUs + disks) is odd, let the final card
	// span both columns so the grid never ends with a lonely half-width cell.
	const oddTail = $derived(info ? (info.gpus.length + info.disks.length) % 2 === 1 : false);

	// --- Project Overview derived presentation (read-only recap) ---
	const deviceStorageTotal = $derived(
		info ? info.disks.reduce((sum, d) => sum + d.sizeBytes, 0) : 0
	);
	const idleStorageShare = $derived(
		overview && deviceStorageTotal > 0
			? (overview.totalStorageIdle / deviceStorageTotal) * 100
			: 0
	);
</script>

<div class="py-1">
	<div class="flex items-center gap-2 mb-1.5">
		<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h3>
		{#if info?.isVirtual}
			<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-sky-500/15 text-sky-600 dark:text-sky-400 rounded text-2xs font-semibold">
				<Icon name="lucide:cloud" class="w-3 h-3" />
				Virtual
			</span>
		{/if}
	</div>
	<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">{subtitle}</p>

	{#if error && !info}
		<div class="flex items-center justify-between gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
			<div class="flex items-center gap-2 min-w-0">
				<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 shrink-0" />
				<span class="text-xs text-red-600 dark:text-red-400 truncate">{error}</span>
			</div>
			<button
				type="button"
				onclick={fetchInfo}
				class="inline-flex items-center gap-1.5 shrink-0 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
			>
				<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
				Retry
			</button>
		</div>
	{:else if !info}
		<!-- Instant skeleton: same card layout as real data, appears immediately without spinner -->
		<div class="flex flex-col gap-3.5 animate-pulse">
			<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
				<div class="flex items-center gap-3.5">
					<div class="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 shrink-0"></div>
					<div class="flex-1 space-y-2 min-w-0">
						<div class="h-3.5 w-32 bg-slate-200 dark:bg-slate-700 rounded"></div>
						<div class="h-3 w-48 bg-slate-200 dark:bg-slate-700 rounded"></div>
					</div>
					<div class="h-6 w-16 bg-slate-200 dark:bg-slate-700 rounded shrink-0"></div>
				</div>
			</div>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
				{#each Array(6) as _, i (i)}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5 mb-2.5">
							<div class="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 shrink-0"></div>
							<div class="flex-1 space-y-2 min-w-0">
								<div class="h-3.5 w-24 bg-slate-200 dark:bg-slate-700 rounded"></div>
								<div class="h-3 w-36 bg-slate-200 dark:bg-slate-700 rounded"></div>
							</div>
							<div class="h-4 w-10 bg-slate-200 dark:bg-slate-700 rounded shrink-0"></div>
						</div>
						<div class="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full"></div>
					</div>
				{/each}
			</div>
		</div>
	{:else}
		<div class="flex flex-col gap-3.5">
			<!-- Identity (full-width header) -->
			<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
				<div class="flex items-center gap-3.5">
					<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-400/15 text-violet-500">
						<Icon name={isServer ? 'lucide:server' : 'lucide:monitor'} class="w-5 h-5" />
					</div>
					<div class="flex flex-col gap-0.5 min-w-0 flex-1">
						<div class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
							{info.hostname}
						</div>
						<div class="text-xs text-slate-600 dark:text-slate-500">
							<span class="font-medium text-slate-700 dark:text-slate-400">{osLabel}</span>
							· {info.arch}
						</div>
					</div>
					<div class="flex flex-col items-end gap-0.5 shrink-0 text-right">
						<div class="text-2xs uppercase tracking-wider text-slate-500">Uptime</div>
						<div class="text-xs font-mono font-medium text-slate-700 dark:text-slate-300">{fmtUptime(info.uptimeSec)}</div>
					</div>
				</div>
			</div>

			<div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
				<!-- Operating System -->
				<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-3.5">
						<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-sky-400/15 text-sky-500">
							<Icon name="lucide:info" class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Operating System</div>
							<div class="text-xs text-slate-600 dark:text-slate-500 truncate">{osLabel}</div>
						</div>
					</div>
					<div class="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
						<div class="flex justify-between gap-2">
							<span class="text-slate-500">Platform</span>
							<span class="font-mono text-slate-700 dark:text-slate-300 truncate">{info.platform}</span>
						</div>
						<div class="flex justify-between gap-2">
							<span class="text-slate-500">Kernel</span>
							<span class="font-mono text-slate-700 dark:text-slate-300 truncate">{info.kernel}</span>
						</div>
					</div>
				</div>

				<!-- Processor -->
				<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-3.5 mb-2.5">
						<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-emerald-400/15 text-emerald-500">
							<Icon name="lucide:cpu" class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Processor</div>
							<div class="text-xs text-slate-600 dark:text-slate-500 truncate">
								{info.cpu.brand || info.cpu.manufacturer || 'CPU'} · {info.cpu.physicalCores} cores{#if info.cpu.speedGhz} · {info.cpu.speedGhz} GHz{/if}
							</div>
						</div>
						<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
							{info.cpu.loadPercent.toFixed(0)}%
						</div>
					</div>
					<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
						<div class="h-full rounded-full transition-all duration-500 {barColor(info.cpu.loadPercent)}" style="width: {Math.min(info.cpu.loadPercent, 100)}%"></div>
					</div>
					{#if info.cpu.loadAvg1 !== null}
						<div class="mt-1.5 text-2xs text-slate-500">Load average (1m): <span class="font-mono">{info.cpu.loadAvg1.toFixed(2)}</span></div>
					{/if}
				</div>

				<!-- Memory -->
				<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-3.5 mb-2.5">
						<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-blue-400/15 text-blue-500">
							<Icon name="lucide:memory-stick" class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Memory</div>
							<div class="text-xs text-slate-600 dark:text-slate-500">
								{fmtBytes(info.memory.usedBytes)} of {fmtBytes(info.memory.totalBytes)} used
							</div>
						</div>
						<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
							{memPercent.toFixed(0)}%
						</div>
					</div>
					<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
						<div class="h-full rounded-full transition-all duration-500 {barColor(memPercent)}" style="width: {Math.min(memPercent, 100)}%"></div>
					</div>
				</div>

				<!-- Swap -->
				<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
					<div class="flex items-center gap-3.5 {info.memory.swapTotalBytes > 0 ? 'mb-2.5' : ''}">
						<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-indigo-400/15 text-indigo-500">
							<Icon name="lucide:arrow-down-up" class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Swap</div>
							<div class="text-xs text-slate-600 dark:text-slate-500">
								{#if info.memory.swapTotalBytes > 0}
									{fmtBytes(info.memory.swapUsedBytes)} of {fmtBytes(info.memory.swapTotalBytes)} used
								{:else}
									Not configured
								{/if}
							</div>
						</div>
						<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
							{info.memory.swapTotalBytes > 0 ? `${swapPercent.toFixed(0)}%` : '—'}
						</div>
					</div>
					{#if info.memory.swapTotalBytes > 0}
						<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
							<div class="h-full rounded-full transition-all duration-500 {barColor(swapPercent)}" style="width: {Math.min(swapPercent, 100)}%"></div>
						</div>
					{/if}
				</div>

				<!-- Battery / Power -->
				{#if info.battery.hasBattery}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5 mb-2.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-amber-400/15 text-amber-500">
								<Icon name={info.battery.isCharging ? 'lucide:battery-charging' : 'lucide:battery'} class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Battery</div>
								<div class="text-xs text-slate-600 dark:text-slate-500">
									{#if info.battery.isCharging}
										Charging{#if info.battery.acConnected} · plugged in{/if}
									{:else if info.battery.acConnected}
										Plugged in, not charging
									{:else}
										On battery{#if info.battery.timeRemainingMinutes} · ~{fmtUptime(info.battery.timeRemainingMinutes * 60)} left{/if}
									{/if}
								</div>
							</div>
							<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
								{info.battery.percent ?? '—'}%
							</div>
						</div>
						<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
							<div
								class="h-full rounded-full transition-all duration-500 {info.battery.isCharging ? 'bg-emerald-500' : ((info.battery.percent ?? 100) <= 20 ? 'bg-red-500' : 'bg-amber-500')}"
								style="width: {info.battery.percent ?? 0}%"
							></div>
						</div>
					</div>
				{:else}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-amber-400/15 text-amber-500">
								<Icon name="lucide:power" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Power</div>
								<div class="text-xs text-slate-600 dark:text-slate-500">On AC power · no battery</div>
							</div>
							<Icon name="lucide:plug" class="w-4 h-4 text-slate-400 shrink-0" />
						</div>
					</div>
				{/if}

				<!-- Graphics -->
				{#each info.disks as disk, i (disk.mount)}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5 mb-2.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-slate-400/15 text-slate-500">
								<Icon name="lucide:hard-drive" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Storage</div>
								<div class="text-xs text-slate-600 dark:text-slate-500 truncate">
									{disk.mount} · {fmtBytes(disk.usedBytes)} of {fmtBytes(disk.sizeBytes)} · {disk.type}
								</div>
							</div>
							<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
								{disk.usePercent.toFixed(0)}%
							</div>
						</div>
						<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
							<div class="h-full rounded-full transition-all duration-500 {barColor(disk.usePercent)}" style="width: {Math.min(disk.usePercent, 100)}%"></div>
						</div>
					</div>
				{/each}

				<!-- Graphics -->
				{#each info.gpus as gpu, i (i)}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5 {gpu.utilizationGpu !== null ? 'mb-2.5' : ''}">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-fuchsia-400/15 text-fuchsia-500">
								<Icon name="lucide:cpu" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Graphics</div>
								<div class="text-xs text-slate-600 dark:text-slate-500 truncate">
									{gpu.model}{#if gpu.vramMb} · {fmtBytes(gpu.vramMb * 1024 * 1024)} VRAM{/if}
								</div>
							</div>
							{#if gpu.utilizationGpu !== null}
								<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300 shrink-0">
									{gpu.utilizationGpu.toFixed(0)}%
								</div>
							{:else}
								<span class="text-2xs text-slate-400 dark:text-slate-500 shrink-0">Utilization N/A</span>
							{/if}
						</div>
						{#if gpu.utilizationGpu !== null}
							<div class="h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
								<div class="h-full rounded-full transition-all duration-500 {barColor(gpu.utilizationGpu)}" style="width: {Math.min(gpu.utilizationGpu, 100)}%"></div>
							</div>
							{#if gpu.memoryTotalMb}
								<div class="mt-1.5 text-2xs text-slate-500">
									VRAM: {fmtBytes((gpu.memoryUsedMb ?? 0) * 1024 * 1024)} / {fmtBytes(gpu.memoryTotalMb * 1024 * 1024)}
								</div>
							{/if}
						{/if}
					</div>
				{/each}

				<!-- Network -->
				<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl {oddTail ? 'sm:col-span-2' : ''}">
					<div class="flex items-center gap-3.5">
						<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-teal-400/15 text-teal-500">
							<Icon name="lucide:network" class="w-5 h-5" />
						</div>
						<div class="flex flex-col gap-0.5 min-w-0 flex-1">
							<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Network</div>
							<div class="text-xs text-slate-600 dark:text-slate-500 truncate">
								Interface {info.network.iface || '—'}
							</div>
						</div>
						<div class="flex flex-col items-end gap-0.5 shrink-0 text-right">
							<div class="text-2xs uppercase tracking-wider text-slate-500">Local IP</div>
							<div class="text-sm font-semibold font-mono text-slate-700 dark:text-slate-300">
								{info.network.ip4 || '—'}
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>
	{/if}

	<!-- Project Overview: read-only recap of idle/completed projects.
	     Visually and logically separate from the Device cards above: own
	     divider, own loading/error states, refreshed by the shared 3s
	     heartbeat — no manual refresh needed. -->
	<div class="mt-6 pt-5 border-t border-slate-200 dark:border-slate-800">
		<div class="flex items-center gap-2 mb-1.5 flex-wrap">
			<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">Project Overview</h3>
			{#if overview}
				<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-500/15 text-violet-600 dark:text-violet-400 rounded text-2xs font-semibold">
					{overview.idleCount} idle / {overview.totalProjects} total
				</span>
			{/if}
		</div>
		<p class="text-sm text-slate-600 dark:text-slate-500 mb-5">Live CPU/RAM plus storage footprint, per project — same figures as Project Info</p>

		{#if overviewError && !overview}
			<div class="flex items-center justify-between gap-3 px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl">
				<div class="flex items-center gap-2 min-w-0">
					<Icon name="lucide:circle-alert" class="w-4 h-4 text-red-500 shrink-0" />
					<span class="text-xs text-red-600 dark:text-red-400 truncate">{overviewError}</span>
				</div>
				<button
					type="button"
					onclick={fetchOverview}
					class="inline-flex items-center gap-1.5 shrink-0 text-xs font-semibold text-violet-600 dark:text-violet-400 hover:underline cursor-pointer"
				>
					<Icon name="lucide:refresh-cw" class="w-3.5 h-3.5" />
					Retry
				</button>
			</div>
		{:else if !overview}
			<div class="grid grid-cols-2 lg:grid-cols-4 gap-3.5 animate-pulse">
				{#each Array(4) as _, i (i)}
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="w-10 h-10 rounded-lg bg-slate-200 dark:bg-slate-700 shrink-0"></div>
							<div class="flex-1 space-y-2 min-w-0">
								<div class="h-3.5 w-20 bg-slate-200 dark:bg-slate-700 rounded"></div>
								<div class="h-3 w-28 bg-slate-200 dark:bg-slate-700 rounded"></div>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{:else if overview.idleCount === 0}
			<div class="flex flex-col items-center gap-2 px-4 py-8 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl text-center">
				<Icon name="lucide:folder-open" class="w-6 h-6 text-slate-400 opacity-60" />
				<span class="text-sm font-medium text-slate-700 dark:text-slate-300">No completed projects yet</span>
				<span class="text-xs text-slate-500">Idle projects will appear here once they stop running</span>
			</div>
		{:else}
			<div class="flex flex-col gap-3.5">
				<!-- Summary cards: always 2 columns like the Device cards above.
				     The settings pane is narrow, so 4-across (lg breakpoint is
				     viewport-based) squeezes the cards and wraps titles. -->
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-400/15 text-violet-500">
								<Icon name="lucide:folder" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Idle Projects</div>
								<div class="text-xs text-slate-600 dark:text-slate-500">{overview.idleCount} of {overview.totalProjects} completed</div>
							</div>
						</div>
					</div>

					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-amber-400/15 text-amber-500">
								<Icon name="lucide:hard-drive" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Storage (Idle)</div>
								<div class="text-xs text-slate-600 dark:text-slate-500 truncate">
									{fmtBytes(overview.totalStorageIdle)}{#if deviceStorageTotal > 0} · {idleStorageShare === 0 ? '0% of device' : idleStorageShare < 0.1 ? '<0.1% of device' : `${idleStorageShare.toFixed(1)}% of device`}{/if}
								</div>
							</div>
						</div>
					</div>

					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-blue-400/15 text-blue-500">
								<Icon name="lucide:files" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Files</div>
								<div class="text-xs text-slate-600 dark:text-slate-500">{overview.totalFilesIdle.toLocaleString()} files</div>
							</div>
						</div>
					</div>

					<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
						<div class="flex items-center gap-3.5">
							<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-slate-400/15 text-slate-500">
								<Icon name="lucide:folder-tree" class="w-5 h-5" />
							</div>
							<div class="flex flex-col gap-0.5 min-w-0 flex-1">
								<div class="text-sm font-semibold text-slate-900 dark:text-slate-100">Directories</div>
								<div class="text-xs text-slate-600 dark:text-slate-500">{overview.totalDirsIdle.toLocaleString()} dirs</div>
							</div>
						</div>
					</div>
				</div>

				<!-- Top 5 -->
				{#if overview.top.length > 0}
					<div class="flex flex-col gap-3">
						<div class="flex items-center gap-2 flex-wrap">
							<h3 class="text-base font-bold text-slate-900 dark:text-slate-100">Top Projects</h3>
							<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-violet-500/15 text-violet-600 dark:text-violet-400 rounded text-2xs font-semibold">
								{filteredTop.length} of {overview.top.length}
							</span>
						</div>
						<!-- Search: same look as the Model search in Engine settings -->
						<div class="relative">
							<svg viewBox="0 0 24 24" fill="none" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" aria-hidden="true">
								<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" />
								<path d="M21 21l-4.35-4.35" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
							</svg>
							<input
								type="text"
								bind:value={topSearch}
								placeholder="Search projects..."
								aria-label="Search top projects"
								class="w-full pl-9 pr-3 py-1.5 text-sm bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-600 transition-colors text-slate-900 dark:text-slate-100 placeholder-slate-400"
							/>
						</div>
						{#if filteredTop.length === 0}
							<p class="px-1 py-3 text-xs text-slate-500 dark:text-slate-500">
								No projects match "{topSearch.trim()}"
							</p>
						{:else}
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
								{#each filteredTop as entry (entry.id)}
									{@const metaLine = `${fmtCompact(entry.fileCount)} files · ${fmtCompact(entry.dirCount)} dirs · opened ${fmtRelative(entry.last_opened_at)}`}
									<div class="px-3.5 pt-1.5 pb-2.5 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
										<!-- Row 1: icon + name + status -->
										<div class="flex items-center gap-2">
											<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-violet-400/15 text-violet-500">
												<Icon name="lucide:folder" class="w-5 h-5" />
											</div>
											<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate flex-1 min-w-0">{entry.name}</span>
											<span
												class="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded text-2xs font-semibold
													{entry.status === 'running'
													? 'bg-green-500/15 text-green-600 dark:text-green-400'
													: 'bg-slate-400/15 text-slate-500'}"
											>
												<span class="w-1.5 h-1.5 rounded-full {entry.status === 'running' ? 'bg-green-500 animate-pulse' : 'bg-slate-400'}"></span>
												{entry.status === 'running' ? 'Running' : 'Idle'}
											</span>
										</div>
										<!-- Row 2: path -->
										<div class="mt-1 text-xs font-mono text-slate-500 truncate" title={entry.path}>{entry.path}</div>
										<!-- Row 3: stat focal points, same order as Project Info -->
										<div class="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-slate-200 dark:border-slate-700">
											<div class="min-w-0">
												<div class="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100 truncate">{fmtCpu(entry.cpuPercent)}</div>
												<div class="text-2xs text-slate-500">CPU</div>
											</div>
											<div class="min-w-0">
												<div class="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100 truncate" title={entry.memRssBytes === null ? 'Unknown' : fmtBytes(entry.memRssBytes)}>{entry.memRssBytes === null ? '—' : fmtBytes(entry.memRssBytes)}</div>
												<div class="text-2xs text-slate-500">RAM</div>
											</div>
											<div class="min-w-0">
												<div class="text-sm font-semibold font-mono text-slate-900 dark:text-slate-100 truncate" title={fmtBytes(entry.sizeBytes)}>{fmtBytes(entry.sizeBytes)}</div>
												<div class="text-2xs text-slate-500">Storage</div>
											</div>
										</div>
										<!-- Row 4: secondary metadata -->
										<div class="mt-1.5 text-2xs text-slate-500 truncate" title={metaLine}>{metaLine}</div>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/if}

				<!-- Unavailable folders: listed, never counted in totals -->
				{#if overview.unmeasurable.length > 0}
					<div class="flex flex-col gap-2">
						<h4 class="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wider">
							Unavailable ({overview.unmeasurable.length})
						</h4>
						<div class="flex flex-col gap-2">
							{#each overview.unmeasurable as entry (entry.id)}
								<div class="px-4 py-3 bg-slate-100/80 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-800 rounded-xl">
									<div class="flex items-center gap-3.5">
										<div class="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 bg-slate-400/15 text-slate-500">
											<Icon name="lucide:folder" class="w-5 h-5" />
										</div>
										<div class="flex flex-col gap-0.5 min-w-0 flex-1">
											<span class="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">{entry.name}</span>
											<div class="text-xs font-mono text-slate-500 truncate" title={entry.path}>{entry.path}</div>
										</div>
										<span class="inline-flex items-center shrink-0 px-1.5 py-0.5 bg-slate-400/15 text-slate-500 rounded text-2xs font-semibold" title={entry.error}>
											Unavailable
										</span>
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/if}

				{#if overview.unmeasurableCount > 0}
					<p class="text-3xs text-slate-400 dark:text-slate-500 text-center">
						{overview.measurableCount} of {overview.idleCount} idle projects measured — totals exclude unavailable folders.
					</p>
				{/if}
			</div>
		{/if}
	</div>
</div>
