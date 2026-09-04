/**
 * Host metrics — what this machine is, and what is running on it.
 *
 * `runner.ts` next door answers host questions by running commands, local or
 * remote. This answers the ones `systeminformation` is better at: hardware
 * identity, and the live process table with per-process CPU and memory.
 *
 * It is one module because two panels already ask these questions and their
 * answers have to line up. Settings → Device reports the whole machine; Project
 * Info reports one project's slice of it. "This project is at 12% and the
 * machine is at 40%" is only a sentence worth printing if both numbers were
 * measured against the same thing — and that is not a promise two independent
 * copies of this code can keep.
 *
 * ## Reading per-process CPU across platforms
 *
 * `si.processes()` reports per-process CPU against a different basis on every
 * platform, so the raw values cannot be summed and labelled the same way:
 *
 * - Linux — a delta over `/proc` jiffies against every core, i.e. already a
 *   share of total machine capacity.
 * - macOS/BSD/SunOS — `ps pcpu`, a decaying recent average in which 100% means
 *   one saturated core, so it has to be divided by the logical core count.
 * - Windows — a delta against the CPU *consumed by processes* during the
 *   interval, not against capacity: one busy process reads close to 100% on an
 *   otherwise idle 8-core box. Scaling it by the machine's busy fraction, taken
 *   from `os.cpus()` tick deltas over the same interval, converts it to a share
 *   of capacity.
 *
 * Everything is therefore normalised to percent of total machine capacity,
 * which is the basis `si.currentLoad()` already reports the host on, so the two
 * panels agree by construction rather than by coincidence.
 *
 * The busy fraction is read here rather than taken from `si.currentLoad()`
 * deliberately: `currentLoad` measures the interval between its own successive
 * calls, and the conversion is only sound over the interval `si.processes()`
 * itself measured. Sampling the ticks at the same instant as the probe is what
 * keeps those two intervals identical.
 *
 * Linux and Windows both need a previous sample before they can produce a
 * delta, so the first probe has no honest answer and the factor is `null` —
 * callers report unknown rather than a zero a panel would render as "idle",
 * the same choice `system:device-info` makes for GPU utilisation.
 */

import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { debug } from '$shared/utils/logger';

/**
 * Race a promise against a deadline. Without a `fallback` the timeout resolves
 * `null`, which keeps the union in the return type and spares callers a cast.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null>;
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T>;
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T | null = null): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
	});
	return Promise.race([promise, timeout])
		.then((value) => {
			clearTimeout(timer);
			return value;
		})
		.catch(() => {
			clearTimeout(timer);
			return fallback;
		});
}

// ── Static facts ─────────────────────────────────────────────────────────────

export interface HostFacts {
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
	/** Installed RAM. Static for the life of the process, and the single
	 *  denominator behind every "percent of host memory" figure. */
	totalMemBytes: number;
	gpus: Array<{ model: string; vendor: string; vramMb: number | null }>;
}

let hostFactsPromise: Promise<HostFacts> | null = null;

/** Hardware identity, probed once per process. */
export function getHostFacts(): Promise<HostFacts> {
	if (!hostFactsPromise) {
		hostFactsPromise = probeHostFacts().catch((err) => {
			// Don't cache a failed probe — allow the next request to retry.
			hostFactsPromise = null;
			throw err;
		});
	}
	return hostFactsPromise;
}

async function probeHostFacts(): Promise<HostFacts> {
	const [osInfo, cpu, system, graphics, mem] = await Promise.all([
		withTimeout(si.osInfo(), 4000),
		withTimeout(si.cpu(), 4000),
		withTimeout(si.system(), 4000),
		withTimeout(si.graphics(), 4000),
		withTimeout(si.mem(), 4000)
	]);

	return {
		hostname: osInfo?.hostname || os.hostname(),
		platform: osInfo?.platform || os.platform(),
		distro: osInfo?.distro || '',
		release: osInfo?.release || os.release(),
		kernel: osInfo?.kernel || os.version(),
		arch: osInfo?.arch || os.arch(),
		isVirtual: Boolean(system?.virtual),
		cpuBrand: cpu?.brand || '',
		cpuManufacturer: cpu?.manufacturer || '',
		physicalCores: cpu?.physicalCores || cpu?.cores || os.cpus().length,
		logicalCores: cpu?.cores || os.cpus().length,
		cpuSpeedGhz: typeof cpu?.speed === 'number' && cpu.speed > 0 ? cpu.speed : null,
		totalMemBytes: typeof mem?.total === 'number' && mem.total > 0 ? mem.total : os.totalmem(),
		gpus: (graphics?.controllers ?? []).map((c) => ({
			model: c.model || 'Unknown GPU',
			vendor: c.vendor || 'Unknown',
			vramMb: typeof c.vram === 'number' && c.vram > 0 ? c.vram : null
		}))
	};
}

// ── Process table ────────────────────────────────────────────────────────────

/**
 * Longer than the 500ms window `si` caches its own process table for, so a
 * cache hit here can never hand back a table whose CPU delta spans a different
 * interval than the `os.cpus()` snapshot it is paired with.
 */
const PROCESS_CACHE_TTL_MS = 2_000;
/** `si.processes()` shells out — to PowerShell on Windows, which can hang. */
const PROCESS_PROBE_TIMEOUT_MS = 10_000;

export interface ProbedProcess {
	pid: number;
	parentPid: number;
	name: string;
	/** Raw `si` percentage. Multiply by `ProcessTable.cpuFactor` to get a share
	 *  of machine capacity; the raw value means something different per OS. */
	cpu: number;
	/** `si` reports RSS in KB on every platform. */
	memRss: number;
	command: string;
}

export interface ProcessTable {
	list: ProbedProcess[];
	/** `null` when no honest conversion to capacity share exists yet. */
	cpuFactor: number | null;
}

let cachedTable: { table: ProcessTable | null; at: number } | null = null;
let inFlightTable: Promise<ProcessTable | null> | null = null;
let lastCpuTicks: { busy: number; total: number } | null = null;
let probeCount = 0;

function readCpuTicks(): { busy: number; total: number } {
	let busy = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		const times = cpu.times;
		const active = times.user + times.nice + times.sys + times.irq;
		busy += active;
		total += active + times.idle;
	}
	return { busy, total };
}

/**
 * The multiplier that turns one `si` CPU percentage into a share of total
 * machine capacity. See the module header for why each platform needs its own.
 */
export function cpuCapacityFactor(
	platform: NodeJS.Platform,
	logicalCores: number,
	busyFraction: number | null,
	hasDelta: boolean
): number | null {
	if (platform === 'linux') return hasDelta ? 1 : null;
	if (platform === 'win32') return hasDelta && busyFraction !== null ? busyFraction : null;
	// macOS, the BSDs and SunOS all read `ps pcpu`, where one core is 100%.
	return logicalCores > 0 ? 1 / logicalCores : null;
}

/**
 * Every descendant of `roots`, by walking a parent → children index once.
 *
 * The index makes this exact at any tree depth. Matching by repeated passes
 * over a flat list instead would silently stop at whatever pass limit bounds
 * the loop, dropping the deep end of a `shell → npm → node → esbuild → …`
 * chain. `seen` doubles as the cycle guard for a process table that reports a
 * parent pid which is itself a descendant (recycled pids on Windows).
 */
export function collectProcessTree(
	list: Array<{ pid: number; parentPid: number }>,
	roots: number[]
): Set<number> {
	const children = new Map<number, number[]>();
	for (const proc of list) {
		if (proc.parentPid === proc.pid) continue;
		const bucket = children.get(proc.parentPid);
		if (bucket) bucket.push(proc.pid);
		else children.set(proc.parentPid, [proc.pid]);
	}

	const seen = new Set<number>(roots);
	const queue = [...roots];
	for (let head = 0; head < queue.length; head++) {
		for (const child of children.get(queue[head]) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			queue.push(child);
		}
	}

	return seen;
}

async function probeProcessTable(): Promise<ProcessTable | null> {
	// Snapshotted at the same instant `si` takes its own sample, so both deltas
	// span the same interval and the Windows conversion stays sound.
	const ticks = readCpuTicks();
	const previous = lastCpuTicks;
	lastCpuTicks = ticks;

	const totalDelta = previous ? ticks.total - previous.total : 0;
	const busyFraction = previous && totalDelta > 0 ? (ticks.busy - previous.busy) / totalDelta : null;

	const result = await withTimeout(si.processes(), PROCESS_PROBE_TIMEOUT_MS);
	if (!result) {
		// A timed-out probe still lands eventually and advances `si`'s internal
		// delta base at a moment we no longer know, so drop our own base too
		// rather than pair it with a mismatched interval next tick.
		debug.warn('host', 'si.processes() unavailable — reporting process metrics as unknown');
		lastCpuTicks = null;
		probeCount = 0;
		return null;
	}

	probeCount++;

	return {
		list: (result.list ?? []).map((p: Systeminformation.ProcessesProcessData) => ({
			pid: p.pid,
			parentPid: p.parentPid,
			name: p.name,
			cpu: typeof p.cpu === 'number' && Number.isFinite(p.cpu) ? p.cpu : 0,
			memRss: typeof p.memRss === 'number' && Number.isFinite(p.memRss) ? p.memRss : 0,
			command: p.command
		})),
		cpuFactor: cpuCapacityFactor(process.platform, os.cpus().length, busyFraction, probeCount >= 2)
	};
}

/**
 * The host process table, cached and single-flighted: N panels polling in step
 * cost one probe per interval rather than one each. `null` when the host could
 * not be asked.
 */
export function getProcessTable(): Promise<ProcessTable | null> {
	if (cachedTable && Date.now() - cachedTable.at < PROCESS_CACHE_TTL_MS) {
		return Promise.resolve(cachedTable.table);
	}
	if (inFlightTable) return inFlightTable;

	inFlightTable = probeProcessTable().then((table) => {
		cachedTable = { table, at: Date.now() };
		inFlightTable = null;
		return table;
	});
	return inFlightTable;
}
