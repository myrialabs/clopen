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

	const POLL_INTERVAL_MS = 2500;

	let info = $state<DeviceInfo | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let timer: ReturnType<typeof setInterval> | null = null;

	async function fetchInfo() {
		try {
			info = await ws.http('system:device-info', {});
			error = null;
		} catch (err) {
			debug.error('settings', 'Failed to fetch device info:', err);
			error = err instanceof Error ? err.message : 'Failed to load device information';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		fetchInfo();
		timer = setInterval(fetchInfo, POLL_INTERVAL_MS);
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

	{#if loading && !info}
		<div class="flex items-center gap-2 text-sm text-slate-500 px-4 py-8">
			<div class="w-4 h-4 border-2 border-slate-400/30 border-t-slate-500 rounded-full animate-spin"></div>
			Reading device information…
		</div>
	{:else if error && !info}
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
	{:else if info}
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
</div>
