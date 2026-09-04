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
 * disagree about the machine they are describing. Dynamic metrics (load,
 * memory in use, battery, disk, GPU utilization) are recomputed on every
 * request so the panel can poll live.
 */

import { t } from 'elysia';
import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { createRouter } from '$shared/utils/ws-server';
import { getHostFacts, withTimeout } from '../../host/metrics';

/** Last-good caches for dynamic probes: prevents transient WMI timeouts from
 *  flickering the UI between "This Device" <-> "Server" or dropping Storage cards. */
let lastMemCache: Systeminformation.MemData | null = null;
let lastBatteryCache: Systeminformation.BatteryData | null = null;
let lastFsSizeCache: Systeminformation.FsSizeData[] | null = null;
let lastLoadCache: Systeminformation.CurrentLoadData | null = null;
let lastGraphicsCache: Systeminformation.GraphicsData | null = null;
let lastNetCache: Systeminformation.NetworkInterfacesData | null = null;

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
		const facts = await getHostFacts();

		const [load, mem, battery, graphics, fsSize, netDefault] = await Promise.all([
			withTimeout(si.currentLoad(), 3500),
			withTimeout(si.mem(), 3500),
			withTimeout(si.battery(), 3500),
			withTimeout(si.graphics(), 3500),
			withTimeout(si.fsSize(), 3500),
			withTimeout(si.networkInterfaces('default'), 3500)
		]);

		// Update last-good caches; reuse them when a probe times out so the UI
		// doesn't flicker between "This Device" <-> "Server" or drop Storage cards.
		if (mem) lastMemCache = mem;
		if (battery) lastBatteryCache = battery;
		if (fsSize) lastFsSizeCache = fsSize;
		if (load) lastLoadCache = load;
		if (graphics) lastGraphicsCache = graphics;
		if (netDefault) lastNetCache = Array.isArray(netDefault) ? netDefault[0] : netDefault;

		const memEff = mem ?? lastMemCache;
		const batteryEff = battery ?? lastBatteryCache;
		const fsSizeEff = fsSize ?? lastFsSizeCache ?? [];
		const loadEff = load ?? lastLoadCache;
		const graphicsEff = graphics ?? lastGraphicsCache;
		const netRawEff = netDefault ?? lastNetCache;
		const net = Array.isArray(netRawEff) ? netRawEff[0] : netRawEff;

		// avgLoad is 0/undefined on platforms without load average (e.g. Windows).
		const loadAvg1 = typeof loadEff?.avgLoad === 'number' && loadEff.avgLoad > 0 ? loadEff.avgLoad : null;

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
				loadPercent: typeof loadEff?.currentLoad === 'number' ? loadEff.currentLoad : 0,
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
				hasBattery: Boolean(batteryEff?.hasBattery),
				percent: typeof batteryEff?.percent === 'number' && batteryEff.hasBattery ? batteryEff.percent : null,
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
	});
