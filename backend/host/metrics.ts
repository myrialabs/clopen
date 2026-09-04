/**
 * Host metrics — hardware identity and the live process table.
 *
 * One module because Settings → Device and Project Info both ask, and their
 * numbers only compare if measured the same way. `si.processes()` reports CPU
 * against a different basis per platform (total capacity on Linux, one core on
 * macOS/BSD, consumed CPU on Windows), so everything is normalised here to
 * percent of machine capacity — the basis `si.currentLoad()` already uses.
 */

import os from 'node:os';
import si from 'systeminformation';
import type { Systeminformation } from 'systeminformation';
import { debug } from '$shared/utils/logger';

/** Race a promise against a deadline. Without a fallback, a timeout gives null. */
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
	/** The single denominator behind every "percent of host memory" figure. */
	totalMemBytes: number;
	gpus: Array<{ model: string; vendor: string; vramMb: number | null }>;
}

let hostFactsPromise: Promise<HostFacts> | null = null;

/** Hardware identity, probed once per process. */
export function getHostFacts(): Promise<HostFacts> {
	if (!hostFactsPromise) {
		hostFactsPromise = probeHostFacts().catch((error) => {
			// Don't cache a failed probe — let the next request retry.
			hostFactsPromise = null;
			throw error;
		});
	}
	return hostFactsPromise;
}

async function probeHostFacts(): Promise<HostFacts> {
	const [osInfo, cpu, system, graphics, memory] = await Promise.all([
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
		totalMemBytes: typeof memory?.total === 'number' && memory.total > 0 ? memory.total : os.totalmem(),
		gpus: (graphics?.controllers ?? []).map((controller) => ({
			model: controller.model || 'Unknown GPU',
			vendor: controller.vendor || 'Unknown',
			vramMb: typeof controller.vram === 'number' && controller.vram > 0 ? controller.vram : null
		}))
	};
}

// ── Process table ────────────────────────────────────────────────────────────

/** Longer than the 500ms window `si` caches its own table for, so a hit here
 *  can never pair a stale table with a fresh `os.cpus()` snapshot. */
const PROCESS_CACHE_TTL_MS = 2_000;
/** `si.processes()` shells out — to PowerShell on Windows, which can hang. */
const PROCESS_PROBE_TIMEOUT_MS = 10_000;

export interface ProbedProcess {
	pid: number;
	parentPid: number;
	name: string;
	/** Raw `si` percentage — multiply by `cpuFactor` for a share of capacity. */
	cpu: number;
	/** `si` reports RSS in KB on every platform. */
	memRss: number;
	command: string;
}

export interface ProcessTable {
	list: ProbedProcess[];
	/** null when no honest conversion to a capacity share exists yet. */
	cpuFactor: number | null;
}

let cachedTable: { table: ProcessTable | null; at: number } | null = null;
let inFlightTable: Promise<ProcessTable | null> | null = null;
let lastCpuTicks: { busy: number; total: number } | null = null;
let probeCount = 0;

function readCpuTicks(): { busy: number; total: number } {
	let busy = 0;
	let total = 0;
	for (const core of os.cpus()) {
		const active = core.times.user + core.times.nice + core.times.sys + core.times.irq;
		busy += active;
		total += active + core.times.idle;
	}
	return { busy, total };
}

/**
 * Multiplier turning one `si` CPU percentage into a share of machine capacity.
 * Linux is already capacity-relative; macOS/BSD count one core as 100%; Windows
 * is relative to CPU the processes consumed, so it scales by the busy fraction.
 */
export function cpuCapacityFactor(
	platform: NodeJS.Platform,
	logicalCores: number,
	busyFraction: number | null,
	hasDelta: boolean
): number | null {
	if (platform === 'linux') return hasDelta ? 1 : null;
	if (platform === 'win32') return hasDelta && busyFraction !== null ? busyFraction : null;
	return logicalCores > 0 ? 1 / logicalCores : null;
}

/**
 * Every descendant of `roots`, via a parent → children index walked once.
 * Exact at any depth, and `seen` guards the pid cycles Windows can report.
 */
export function collectProcessTree(
	list: Array<{ pid: number; parentPid: number }>,
	roots: number[]
): Set<number> {
	const children = new Map<number, number[]>();
	for (const entry of list) {
		if (entry.parentPid === entry.pid) continue;
		const siblings = children.get(entry.parentPid);
		if (siblings) siblings.push(entry.pid);
		else children.set(entry.parentPid, [entry.pid]);
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
	// Sampled at the instant `si` takes its own sample, so both deltas span the
	// same interval and the Windows conversion stays sound.
	const ticks = readCpuTicks();
	const previous = lastCpuTicks;
	lastCpuTicks = ticks;

	const totalDelta = previous ? ticks.total - previous.total : 0;
	const busyFraction = previous && totalDelta > 0 ? (ticks.busy - previous.busy) / totalDelta : null;

	const result = await withTimeout(si.processes(), PROCESS_PROBE_TIMEOUT_MS);
	if (!result) {
		// A timed-out probe still lands later and moves `si`'s delta base at a
		// moment we no longer know, so drop our base rather than mismatch it.
		debug.warn('host', 'si.processes() unavailable — reporting process metrics as unknown');
		lastCpuTicks = null;
		probeCount = 0;
		return null;
	}

	probeCount++;

	return {
		list: (result.list ?? []).map((entry: Systeminformation.ProcessesProcessData) => ({
			pid: entry.pid,
			parentPid: entry.parentPid,
			name: entry.name,
			cpu: typeof entry.cpu === 'number' && Number.isFinite(entry.cpu) ? entry.cpu : 0,
			memRss: typeof entry.memRss === 'number' && Number.isFinite(entry.memRss) ? entry.memRss : 0,
			command: entry.command
		})),
		// Linux and Windows need a second sample before a delta exists.
		cpuFactor: cpuCapacityFactor(process.platform, os.cpus().length, busyFraction, probeCount >= 2)
	};
}

/** Cached and single-flighted: N panels polling in step cost one probe. */
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
