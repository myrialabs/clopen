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
 * Static facts (OS, CPU model, core count, installed RAM, GPU model,
 * virtualization) come from `backend/host/metrics.ts`, which probes them once
 * per process and is also what Project Info reads, so the two panels cannot
 * disagree about the machine they are describing. Fast live metrics (CPU via
 * OS deltas, memory, network, uptime) are re-read on every request so the
 * panel polls live. Slow WMI-bound metrics (battery, disk usage, GPU) are
 * cached for 60s and refreshed in the background, so one timed-out probe can
 * never flip the panel between "This Device" <-> "Server" or drop cards.
 */

import { t } from 'elysia';
import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { createRouter } from '$shared/utils/ws-server';
import { getHostFacts, withTimeout } from '../../host/metrics';

/** Two-tier probing. Fast signals (CPU via os deltas, memory, network, uptime)
 *  are cheap and re-read on every request. Slow signals (battery, disk usage,
 *  GPU) shell out to WMI/PowerShell, change slowly, and time out under load —
 *  re-probing them every 3.5s poll is what made the panel flip between
 *  "This Device" <-> "Server" and made Battery/Swap/Storage cards appear and
 *  vanish on every open/close. Slow signals are cached for SLOW_TTL_MS and
 *  refreshed in the background; a request only waits for them on cold start
 *  when no snapshot exists at all. */
const LAST_GOOD_MAX_AGE_MS = 60_000;
const SLOW_TTL_MS = 60_000;
interface TimedCache<T> { value: T; at: number }
let lastMemCache: TimedCache<Systeminformation.MemData> | null = null;
let lastNetCache: TimedCache<Systeminformation.NetworkInterfacesData> | null = null;

function fresh<T>(cache: TimedCache<T> | null): T | null {
	if (!cache || Date.now() - cache.at > LAST_GOOD_MAX_AGE_MS) return null;
	return cache.value;
}

interface SlowSnapshot {
	battery: Systeminformation.BatteryData | null;
	fsSize: Systeminformation.FsSizeData[] | null;
	graphics: Systeminformation.GraphicsData | null;
	at: number;
}
let slowCache: SlowSnapshot | null = null;
let slowInFlight: Promise<SlowSnapshot> | null = null;

/** Battery presence is sticky: WMI transiently reports no-battery/timeout on
 *  laptops under load, which used to flip the whole panel to "Server". Only
 *  three consecutive *explicit* no-battery readings (not timeouts) clear it. */
let stickyHasBattery = false;
let batteryFalseStreak = 0;

async function probeSlow(): Promise<SlowSnapshot> {
	const [battery, graphics, fsSize] = await Promise.all([
		withTimeout(si.battery(), 8000),
		withTimeout(si.graphics(), 8000),
		withTimeout(si.fsSize(), 8000)
	]);
	if (battery) {
		if (battery.hasBattery) {
			stickyHasBattery = true;
			batteryFalseStreak = 0;
		} else if (++batteryFalseStreak >= 3) {
			stickyHasBattery = false;
		}
	}
	const snapshot: SlowSnapshot = { battery, fsSize, graphics, at: Date.now() };
	// Merge: never let one timed-out probe wipe a good snapshot from another.
	if (slowCache) {
		if (!snapshot.battery) snapshot.battery = slowCache.battery;
		if (!snapshot.fsSize) snapshot.fsSize = slowCache.fsSize;
		if (!snapshot.graphics) snapshot.graphics = slowCache.graphics;
	}
	slowCache = snapshot;
	return snapshot;
}

/** Slow signals for one request: fresh cache served instantly, stale cache
 *  served instantly while a background refresh runs, cold start awaits. */
function ensureSlow(): Promise<SlowSnapshot> {
	if (slowCache && Date.now() - slowCache.at < SLOW_TTL_MS) {
		return Promise.resolve(slowCache);
	}
	if (slowInFlight) return slowInFlight;
	slowInFlight = probeSlow().then((snapshot) => {
		slowInFlight = null;
		return snapshot;
	});
	slowInFlight.then(
		() => {},
		() => {
			slowInFlight = null;
		}
	);
	// Stale-but-usable snapshot wins over waiting: the Device tab must open
	// instantly with consistent cards, then correct itself next poll.
	if (slowCache) return Promise.resolve(slowCache);
	return slowInFlight;
}

/** Rolling OS-level CPU measurement (same source Task Manager samples).
 *  `si.currentLoad()` on a cold process — especially while 11 WMI/PowerShell
 *  probes run concurrently — can spike to 100%, and the spike is partly the
 *  measurement storm itself. Sampling `os.cpus()` deltas between requests
 *  (the ~3.5s poll interval) measures the real machine load instead. */
let lastCpuSample: { busy: number; total: number; at: number } | null = null;
let lastCpuPercent: number | null = null;

function sampleOsCpuPercent(): number | null {
	let busy = 0;
	let total = 0;
	for (const core of os.cpus()) {
		const active = core.times.user + core.times.nice + core.times.sys + core.times.irq;
		busy += active;
		total += active + core.times.idle;
	}
	const now = Date.now();
	const prev = lastCpuSample;
	lastCpuSample = { busy, total, at: now };
	if (prev && now - prev.at >= 500 && total - prev.total > 0) {
		const pct = ((busy - prev.busy) / (total - prev.total)) * 100;
		lastCpuPercent = Math.min(100, Math.max(0, pct));
	}
	return lastCpuPercent;
}

/** OS fallback for the default network interface when `si` returns nothing
 *  (e.g. transient WMI timeout): first up, non-internal IPv4 interface. */
function osFallbackNetwork(): { iface: string; ip4: string; mac: string } | null {
	const ifaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(ifaces)) {
		for (const addr of addrs ?? []) {
			if (addr.internal || addr.family !== 'IPv4' || !addr.address) continue;
			// Skip virtual/tunnel adapters without a real MAC.
			if (!addr.mac || addr.mac === '00:00:00:00:00:00') continue;
			return { iface: name, ip4: addr.address, mac: addr.mac };
		}
	}
	return null;
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

/** Response snapshot served from cache inside the TTL so the 3.5s frontend
 *  poll and rapid tab switches never re-run the si.* probes. */
interface DeviceInfoPayload {
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
	gpus: Array<{
		model: string;
		vendor: string;
		vramMb: number | null;
		utilizationGpu: number | null;
		memoryUsedMb: number | null;
		memoryTotalMb: number | null;
	}>;
	disks: DiskInfo[];
}

/** Shorter than the frontend 3.5s poll so a poll always hits a fresh cache. */
const DEVICE_CACHE_TTL_MS = 3000;
let cachedDevice: { payload: DeviceInfoPayload; at: number } | null = null;
let inFlightDevice: Promise<DeviceInfoPayload> | null = null;

async function buildDeviceInfo(): Promise<DeviceInfoPayload> {
		// Static facts and live probes launch together. They used to run one
		// after another (facts ~4s cold, then probes ~3.5s), which stacked past
		// 7s on first open while other settings tabs render instantly.
		// Concurrent, the slowest single phase bounds the total.
		const factsP = getHostFacts();

		// OS-level CPU sample taken at request start; the delta is measured
		// against the previous request (~3.5s poll), free of probe overhead.
		const osCpuPercent = sampleOsCpuPercent();

		// Per-poll storm cut from ~11 concurrent spawns to 3: only CPU
		// fallback, memory, and network run here. Battery/disks/GPU come
		// from the slow tier so one WMI timeout can no longer flip cards
		// or inflate the CPU reading with its own measurement cost.
		const dynamicP = Promise.all([
			// si CPU is only a first-poll fallback; once the OS delta has a
			// baseline it is both cheaper and more accurate, so skip the spawn.
			osCpuPercent !== null
				? Promise.resolve(null)
				: withTimeout(si.currentLoad(), 3500),
			withTimeout(si.mem(), 3500),
			withTimeout(si.networkInterfaces('default'), 3500),
			ensureSlow()
		]);

		const [facts, [load, mem, netDefault, slow]] = await Promise.all([
			factsP,
			dynamicP
		]);

		// Update last-good caches; reuse them when a probe times out so the UI
		// doesn't flicker between "This Device" <-> "Server" or drop Storage cards.
		// Stale entries (>60s) are ignored so timed-out probes can't pin old
		// numbers as live device state forever.
		const now = Date.now();
		if (mem) lastMemCache = { value: mem, at: now };
		if (netDefault) lastNetCache = { value: Array.isArray(netDefault) ? netDefault[0] : netDefault, at: now };

		const memEff = mem ?? fresh(lastMemCache);
		const batteryEff = slow.battery;
		const fsSizeEff = slow.fsSize ?? [];
		const graphicsEff = slow.graphics;
		const netRawEff = netDefault ?? fresh(lastNetCache);
		const netSi = Array.isArray(netRawEff) ? netRawEff[0] : netRawEff;
		const netOsFallback = !netSi?.ip4 ? osFallbackNetwork() : null;
		const net = netSi?.ip4 ? netSi : netOsFallback;

		// Authoritative 1-minute load average straight from the OS (zeros on
		// Windows → null, same as before, but without waiting on si timing).
		const osAvg1 = os.loadavg()[0];
		const loadAvg1 = typeof osAvg1 === 'number' && osAvg1 > 0 ? osAvg1 : null;

		// Pair live GPU utilization with the cached controller identity by index.
		const gpus = facts.gpus.map((g, i) => {
			const live = graphicsEff?.controllers?.[i];
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
		const disks = selectPrimaryDisks(fsSizeEff, facts.platform);

		return {
			hostname: facts.hostname,
			platform: facts.platform,
			distro: facts.distro,
			release: facts.release,
			kernel: facts.kernel,
			arch: facts.arch,
			isVirtual: facts.isVirtual,
			uptimeSec: os.uptime(),
			cpu: {
				brand: facts.cpuBrand,
				manufacturer: facts.cpuManufacturer,
				physicalCores: facts.physicalCores,
				logicalCores: facts.logicalCores,
				speedGhz: facts.cpuSpeedGhz,
				// Percent of total machine capacity — the same basis Project Info
				// normalises its per-project figure to, so the two are comparable.
				// OS-delta first (immune to the si cold-start spike and to the
				// probe storm's own CPU cost), si reading as fallback.
				loadPercent: osCpuPercent ?? (typeof load?.currentLoad === 'number' ? load.currentLoad : 0),
				loadAvg1
			},
			memory: {
				// Installed RAM comes from the shared host facts so this total and
				// the one Project Info divides by are always the same number.
				totalBytes: facts.totalMemBytes,
				usedBytes: memEff?.active ?? os.totalmem() - os.freemem(),
				freeBytes: memEff?.available ?? os.freemem(),
				swapTotalBytes: memEff?.swaptotal ?? 0,
				swapUsedBytes: memEff?.swapused ?? 0
			},
			network: {
				iface: net?.iface || '',
				ip4: net?.ip4 || '',
				mac: net?.mac || ''
			},
			battery: {
				// Sticky presence: a single timed-out/no-battery WMI read must
				// not flip the panel to "Server" on a laptop with a battery.
				hasBattery: stickyHasBattery || Boolean(batteryEff?.hasBattery),
				// Rounded to a whole percent like the OS taskbar/menu-bar shows;
				// si can report floats on some platforms (e.g. 27.6 → 28).
				percent: typeof batteryEff?.percent === 'number' && batteryEff.hasBattery ? Math.round(batteryEff.percent) : null,
				isCharging: Boolean(batteryEff?.isCharging),
				acConnected: Boolean(batteryEff?.acConnected),
				timeRemainingMinutes:
					typeof batteryEff?.timeRemaining === 'number' && batteryEff.timeRemaining > 0
						? batteryEff.timeRemaining
						: null
			},
			gpus,
			disks
		};
}

function getDeviceInfo(): Promise<DeviceInfoPayload> {
	if (cachedDevice && Date.now() - cachedDevice.at < DEVICE_CACHE_TTL_MS) {
		return Promise.resolve(cachedDevice.payload);
	}
	if (inFlightDevice) return inFlightDevice;

	inFlightDevice = buildDeviceInfo().then((payload) => {
		cachedDevice = { payload, at: Date.now() };
		inFlightDevice = null;
		return payload;
	});
	inFlightDevice.then(
		() => {},
		() => {
			inFlightDevice = null;
		}
	);
	return inFlightDevice;
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
	}, async () => getDeviceInfo());
