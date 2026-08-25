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

/** Static facts don't change while the process runs — resolve them once. */
let staticInfoPromise: Promise<StaticInfo> | null = null;

async function getStaticInfo(): Promise<StaticInfo> {
	if (!staticInfoPromise) {
		staticInfoPromise = (async () => {
			const [osInfo, cpu, system, graphics] = await Promise.all([
				si.osInfo(),
				si.cpu(),
				si.system(),
				si.graphics()
			]);
			return {
				hostname: osInfo.hostname || os.hostname(),
				platform: osInfo.platform,
				distro: osInfo.distro,
				release: osInfo.release,
				kernel: osInfo.kernel,
				arch: osInfo.arch || os.arch(),
				isVirtual: Boolean(system.virtual),
				cpuBrand: cpu.brand,
				cpuManufacturer: cpu.manufacturer,
				physicalCores: cpu.physicalCores || cpu.cores,
				logicalCores: cpu.cores,
				cpuSpeedGhz: typeof cpu.speed === 'number' && cpu.speed > 0 ? cpu.speed : null,
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
			si.currentLoad(),
			si.mem(),
			si.battery(),
			si.graphics(),
			si.fsSize(),
			si.networkInterfaces('default')
		]);

		// networkInterfaces('default') returns the single default interface, but
		// normalize defensively in case a build returns an array.
		const net = Array.isArray(netDefault) ? netDefault[0] : netDefault;

		// avgLoad is 0/undefined on platforms without load average (e.g. Windows).
		const loadAvg1 = typeof load.avgLoad === 'number' && load.avgLoad > 0 ? load.avgLoad : null;

		// Pair live GPU utilization with the cached controller identity by index.
		const gpus = staticInfo.gpus.map((g, i) => {
			const live = graphics.controllers[i];
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
		const disks = selectPrimaryDisks(fsSize, staticInfo.platform);

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
				loadPercent: typeof load.currentLoad === 'number' ? load.currentLoad : 0,
				loadAvg1
			},
			memory: {
				totalBytes: mem.total,
				usedBytes: mem.active,
				freeBytes: mem.available,
				swapTotalBytes: mem.swaptotal,
				swapUsedBytes: mem.swapused
			},
			network: {
				iface: net?.iface || '',
				ip4: net?.ip4 || '',
				mac: net?.mac || ''
			},
			battery: {
				hasBattery: Boolean(battery.hasBattery),
				percent: typeof battery.percent === 'number' && battery.hasBattery ? battery.percent : null,
				isCharging: Boolean(battery.isCharging),
				acConnected: Boolean(battery.acConnected),
				timeRemainingMinutes:
					typeof battery.timeRemaining === 'number' && battery.timeRemaining > 0
						? battery.timeRemaining
						: null
			},
			gpus,
			disks
		};
	});
