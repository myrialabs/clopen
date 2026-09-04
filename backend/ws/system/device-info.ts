/**
 * Device Info
 *
 * HTTP endpoint reporting general information about the machine running clopen
 * (the server), designed to work both on a local desktop/laptop and on a
 * headless VPS.
 *
 * Cross-platform notes:
 * - Battery is absent on desktops/VPS — `battery.hasBattery` is false there.
 * - GPU utilization is best-effort: macOS and most headless Linux servers do
 *   not expose it (only NVIDIA via nvidia-smi typically does), so util fields
 *   are `null` when unavailable rather than a misleading `0`.
 *
 * Static facts (OS, CPU model, core count, GPU model, virtualization) are
 * captured once per process; dynamic metrics (load, memory, battery, disk,
 * GPU utilization) are recomputed on every request so the panel can poll live.
 */

import { t } from 'elysia';
import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { createRouter } from '$shared/utils/ws-server';

interface StaticInfo {
	hostname: string;
	platform: string;
	distro: string;
	release: string;
	kernel: string;
	arch: string;
	isVirtual: boolean;
	cpuBrand: string;
	cpuManufacturer: string;
	physicalCores: number;
	logicalCores: number;
	cpuSpeedGhz: number | null;
	gpus: Array<{ model: string; vendor: string; vramMb: number | null }>;
}

/** Timeout helper: race a promise against a deadline, return fallback on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout])
		.then((v) => {
			clearTimeout(timer);
			return v;
		})
		.catch(() => {
			clearTimeout(timer);
			return fallback;
		});
}

/** Static facts don't change while the process runs — resolve them once. */
let staticInfoPromise: Promise<StaticInfo> | null = null;

/** Last-good caches for dynamic probes: prevents transient WMI timeouts from
 *  flickering the UI between "This Device" <-> "Server" or dropping Storage cards. */
let lastMemCache: Systeminformation.MemData | null = null;
let lastBatteryCache: Systeminformation.BatteryData | null = null;
let lastFsSizeCache: Systeminformation.FsSizeData[] | null = null;
let lastLoadCache: Systeminformation.CurrentLoadData | null = null;
let lastGraphicsCache: Systeminformation.GraphicsData | null = null;
let lastNetCache: Systeminformation.NetworkInterfacesData | null = null;

async function getStaticInfo(): Promise<StaticInfo> {
	if (!staticInfoPromise) {
		staticInfoPromise = (async () => {
			const fallbackOs = {
				hostname: os.hostname(),
				platform: os.platform(),
				distro: '',
				release: os.release(),
				kernel: os.version(),
				arch: os.arch()
			} as unknown as Systeminformation.OsData;
			const fallbackCpu = {
				brand: '',
				manufacturer: '',
				physicalCores: os.cpus().length,
				cores: os.cpus().length,
				speed: 0
			} as unknown as Systeminformation.CpuData;
			const fallbackSystem = { virtual: false } as unknown as Systeminformation.SystemData;
			const fallbackGraphics = { controllers: [] } as unknown as Systeminformation.GraphicsData;
			const [osInfo, cpu, system, graphics] = await Promise.all([
				withTimeout(si.osInfo(), 4000, fallbackOs),
				withTimeout(si.cpu(), 4000, fallbackCpu),
				withTimeout(si.system(), 4000, fallbackSystem),
				withTimeout(si.graphics(), 4000, fallbackGraphics)
			]);
			return {
				hostname: (osInfo?.hostname || os.hostname()) as string,
				platform: (osInfo?.platform || os.platform()) as string,
				distro: (osInfo?.distro || '') as string,
				release: (osInfo?.release || os.release()) as string,
				kernel: (osInfo?.kernel || os.version()) as string,
				arch: (osInfo?.arch || os.arch()) as string,
				isVirtual: Boolean(system?.virtual),
				cpuBrand: (cpu?.brand || '') as string,
				cpuManufacturer: (cpu?.manufacturer || '') as string,
				physicalCores: (cpu?.physicalCores || cpu?.cores || os.cpus().length) as number,
				logicalCores: (cpu?.cores || os.cpus().length) as number,
				cpuSpeedGhz: typeof cpu?.speed === 'number' && cpu.speed > 0 ? cpu.speed : null,
				gpus: graphics.controllers.map((c) => ({
					model: c.model || 'Unknown GPU',
					vendor: c.vendor || 'Unknown',
					vramMb: typeof c.vram === 'number' && c.vram > 0 ? c.vram : null
				}))
			};
		})().catch((err) => {
			// Don't cache a failed probe — allow the next request to retry.
			staticInfoPromise = null;
			throw err;
		});
	}
	return staticInfoPromise;
}

const GpuSchema = t.Object({
	model: t.String(),
	vendor: t.String(),
	vramMb: t.Union([t.Number(), t.Null()]),
	utilizationGpu: t.Union([t.Number(), t.Null()]),
	memoryUsedMb: t.Union([t.Number(), t.Null()]),
	memoryTotalMb: t.Union([t.Number(), t.Null()])
});

const DiskSchema = t.Object({
	mount: t.String(),
	type: t.String(),
	sizeBytes: t.Number(),
	usedBytes: t.Number(),
	usePercent: t.Number()
});

const BatterySchema = t.Object({
	hasBattery: t.Boolean(),
	percent: t.Union([t.Number(), t.Null()]),
	isCharging: t.Boolean(),
	acConnected: t.Boolean(),
	timeRemainingMinutes: t.Union([t.Number(), t.Null()])
});

/** Filesystem pseudo/virtual types that never represent a real disk. */
const PSEUDO_FS_TYPES = new Set([
	'tmpfs', 'devtmpfs', 'devfs', 'overlay', 'squashfs', 'autofs',
	'none', 'nullfs', 'fuse', 'fuseblk', 'tracefs', 'proc', 'sysfs'
]);

/** Mount-point prefixes that are OS internals, not user-facing storage. */
const INTERNAL_MOUNT_PREFIXES = ['/private', '/dev', '/nix', '/Library/Developer', '/System/Library'];

interface DiskInfo {
	mount: string;
	type: string;
	sizeBytes: number;
	usedBytes: number;
	usePercent: number;
}

/**
 * Reduce the raw filesystem list to just the primary disk(s).
 *
 * The raw list is noisy — especially on macOS, where APFS exposes a dozen
 * synthetic volumes (Preboot, VM, Update, xarts, Data, …) that all share one
 * physical container, plus tiny 500 MB system volumes. We drop pseudo
 * filesystems and OS-internal mounts, then on macOS collapse each physical
 * container (grouped by identical total size) down to the volume that actually
 * holds the data (highest usage) so the user sees one meaningful entry.
 */
function selectPrimaryDisks(raw: Systeminformation.FsSizeData[], platform: string): DiskInfo[] {
	const isMac = platform === 'darwin';

	const candidates = raw.filter((d) => {
		if (!d.size || d.size <= 0) return false;
		if (PSEUDO_FS_TYPES.has((d.type || '').toLowerCase())) return false;
		if (d.mount === '/') return true; // root is always primary
		if (INTERNAL_MOUNT_PREFIXES.some((p) => d.mount.startsWith(p))) return false;
		// macOS: keep only the real Data volume among the /System/Volumes/* set.
		if (d.mount.startsWith('/System/Volumes/') && d.mount !== '/System/Volumes/Data') return false;
		// Drop sub-1 GB helper volumes (boot/EFI/recovery) — not "main" storage.
		return d.size >= 1024 ** 3;
	});

	// macOS: many volumes map to one physical container (identical total size).
	// Keep the fullest representative per container so we show one entry per disk.
	const chosen = isMac
		? [
			...candidates
				.reduce((byContainer, d) => {
					const cur = byContainer.get(d.size);
					if (!cur || d.used > cur.used) byContainer.set(d.size, d);
					return byContainer;
				}, new Map<number, Systeminformation.FsSizeData>())
				.values()
		]
		: candidates;

	return chosen
		.map((d) => ({
			// Relabel the collapsed macOS container as the root drive instead of an
			// internal path like /System/Volumes/Data.
			mount: isMac && d.mount.startsWith('/System/Volumes/') ? '/' : d.mount,
			type: d.type,
			sizeBytes: d.size,
			usedBytes: d.used,
			usePercent: typeof d.use === 'number' ? d.use : d.used / d.size * 100
		}))
		// Root first, then largest disks.
		.sort((a, b) => (a.mount === '/' ? -1 : b.mount === '/' ? 1 : b.sizeBytes - a.sizeBytes));
}

export const deviceInfoHandler = createRouter()
	.http('system:device-info', {
		data: t.Object({}),
		response: t.Object({
			hostname: t.String(),
			platform: t.String(),
			distro: t.String(),
			release: t.String(),
			kernel: t.String(),
			arch: t.String(),
			isVirtual: t.Boolean(),
			uptimeSec: t.Number(),
			cpu: t.Object({
				brand: t.String(),
				manufacturer: t.String(),
				physicalCores: t.Number(),
				logicalCores: t.Number(),
				speedGhz: t.Union([t.Number(), t.Null()]),
				loadPercent: t.Number(),
				loadAvg1: t.Union([t.Number(), t.Null()])
			}),
			memory: t.Object({
				totalBytes: t.Number(),
				usedBytes: t.Number(),
				freeBytes: t.Number(),
				swapTotalBytes: t.Number(),
				swapUsedBytes: t.Number()
			}),
			network: t.Object({
				iface: t.String(),
				ip4: t.String(),
				mac: t.String()
			}),
			battery: BatterySchema,
			gpus: t.Array(GpuSchema),
			disks: t.Array(DiskSchema)
		})
	}, async () => {
		const staticInfo = await getStaticInfo();

		const [load, mem, battery, graphics, fsSize, netDefault] = await Promise.all([
			withTimeout(si.currentLoad(), 3500, null as unknown as Systeminformation.CurrentLoadData | null),
			withTimeout(si.mem(), 3500, null as unknown as Systeminformation.MemData | null),
			withTimeout(si.battery(), 3500, null as unknown as Systeminformation.BatteryData | null),
			withTimeout(si.graphics(), 3500, null as unknown as Systeminformation.GraphicsData | null),
			withTimeout(si.fsSize(), 3500, null as unknown as Systeminformation.FsSizeData[] | null),
			withTimeout(si.networkInterfaces('default'), 3500, null as unknown as Systeminformation.NetworkInterfacesData | null)
		]);

		// Update last-good caches; reuse them when a probe times out so the UI
		// doesn't flicker between "This Device" <-> "Server" or drop Storage cards.
		if (mem) lastMemCache = mem as unknown as Systeminformation.MemData;
		if (battery) lastBatteryCache = battery as unknown as Systeminformation.BatteryData;
		if (fsSize) lastFsSizeCache = fsSize as unknown as Systeminformation.FsSizeData[];
		if (load) lastLoadCache = load as unknown as Systeminformation.CurrentLoadData;
		if (graphics) lastGraphicsCache = graphics as unknown as Systeminformation.GraphicsData;
		if (netDefault) lastNetCache = (Array.isArray(netDefault) ? netDefault[0] : netDefault) as unknown as Systeminformation.NetworkInterfacesData;

		const memEff = (mem as unknown as Systeminformation.MemData) ?? lastMemCache;
		const batteryEff = (battery as unknown as Systeminformation.BatteryData) ?? lastBatteryCache;
		const fsSizeEff = (fsSize as unknown as Systeminformation.FsSizeData[]) ?? lastFsSizeCache ?? [];
		const loadEff = (load as unknown as Systeminformation.CurrentLoadData) ?? lastLoadCache;
		const graphicsEff = (graphics as unknown as Systeminformation.GraphicsData) ?? lastGraphicsCache ?? { controllers: [] } as unknown as Systeminformation.GraphicsData;
		const netRawEff = (netDefault as unknown as Systeminformation.NetworkInterfacesData | null) ?? lastNetCache;
		const net = Array.isArray(netRawEff) ? netRawEff[0] : (netRawEff as unknown as Systeminformation.NetworkInterfacesData | null);

		// avgLoad is 0/undefined on platforms without load average (e.g. Windows).
		const loadAvg1 = typeof (loadEff as unknown as { avgLoad?: number })?.avgLoad === 'number' && (loadEff as unknown as { avgLoad: number }).avgLoad > 0 ? (loadEff as unknown as { avgLoad: number }).avgLoad : null;

		// Pair live GPU utilization with the cached controller identity by index.
		const gpus = staticInfo.gpus.map((g, i) => {
			const live = (graphicsEff as Systeminformation.GraphicsData)?.controllers?.[i];
			return {
				model: g.model,
				vendor: g.vendor,
				vramMb: g.vramMb,
				utilizationGpu: live && typeof live.utilizationGpu === 'number' ? live.utilizationGpu : null,
				memoryUsedMb: live && typeof live.memoryUsed === 'number' ? live.memoryUsed : null,
				memoryTotalMb: live && typeof live.memoryTotal === 'number' ? live.memoryTotal : null
			};
		});

		// Show only the primary disk(s); collapses macOS APFS synthetic volumes.
		const disks = selectPrimaryDisks((fsSizeEff as Systeminformation.FsSizeData[]) || [], staticInfo.platform);

		return {
			hostname: staticInfo.hostname,
			platform: staticInfo.platform,
			distro: staticInfo.distro,
			release: staticInfo.release,
			kernel: staticInfo.kernel,
			arch: staticInfo.arch,
			isVirtual: staticInfo.isVirtual,
			uptimeSec: os.uptime(),
			cpu: {
				brand: staticInfo.cpuBrand,
				manufacturer: staticInfo.cpuManufacturer,
				physicalCores: staticInfo.physicalCores,
				logicalCores: staticInfo.logicalCores,
				speedGhz: staticInfo.cpuSpeedGhz,
				loadPercent: typeof (loadEff as unknown as { currentLoad?: number })?.currentLoad === 'number' ? (loadEff as unknown as { currentLoad: number }).currentLoad : 0,
				loadAvg1
			},
			memory: {
				totalBytes: (memEff as unknown as Systeminformation.MemData)?.total ?? os.totalmem(),
				usedBytes: (memEff as unknown as Systeminformation.MemData)?.active ?? os.totalmem() - os.freemem(),
				freeBytes: (memEff as unknown as Systeminformation.MemData)?.available ?? os.freemem(),
				swapTotalBytes: (memEff as unknown as Systeminformation.MemData)?.swaptotal ?? 0,
				swapUsedBytes: (memEff as unknown as Systeminformation.MemData)?.swapused ?? 0
			},
			network: {
				iface: (net as unknown as { iface?: string })?.iface || '',
				ip4: (net as unknown as { ip4?: string })?.ip4 || '',
				mac: (net as unknown as { mac?: string })?.mac || ''
			},
			battery: {
				hasBattery: Boolean((batteryEff as unknown as Systeminformation.BatteryData)?.hasBattery),
				percent: typeof (batteryEff as unknown as Systeminformation.BatteryData)?.percent === 'number' && (batteryEff as unknown as Systeminformation.BatteryData)?.hasBattery ? (batteryEff as unknown as Systeminformation.BatteryData).percent : null,
				isCharging: Boolean((batteryEff as unknown as Systeminformation.BatteryData)?.isCharging),
				acConnected: Boolean((batteryEff as unknown as Systeminformation.BatteryData)?.acConnected),
				timeRemainingMinutes:
					typeof (batteryEff as unknown as Systeminformation.BatteryData)?.timeRemaining === 'number' && (batteryEff as unknown as Systeminformation.BatteryData).timeRemaining > 0
						? (batteryEff as unknown as Systeminformation.BatteryData).timeRemaining
						: null
			},
			gpus,
			disks
		};
	});
