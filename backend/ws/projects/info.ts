/**
 * Projects Info — what one project costs on this machine.
 *
 * Two independent probes, both bounded, both shared between concurrent callers
 * so that N open panels polling every few seconds cost one probe per interval
 * rather than N:
 *
 * - Storage: a recursive walk of `project.path`. Nothing is excluded — `.git`
 *   and `node_modules` are part of what the folder actually occupies — so the
 *   walk is stopped by whichever of `MAX_ENTRIES` or `WALK_DEADLINE_MS` comes
 *   first and reports `truncated` when it was.
 * - CPU/RAM: the PTY shells Clopen opened for this project plus every live
 *   descendant of them. Nothing else on the host is counted, so this is the
 *   project's own footprint and not the server's. Engine processes that Clopen
 *   runs outside a terminal are not shells and do not appear here.
 *
 * ## Why the CPU number is not `si`'s CPU number
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
 * Everything is therefore normalised to "percent of total machine capacity",
 * which is the only reading of "this project is using X% CPU" that means the
 * same thing on a laptop and on a 32-core VPS.
 *
 * Linux and Windows both need a previous sample before they can produce a
 * delta, so the first probe has no honest answer and `cpuPercent` is `null`
 * there rather than a zero the panel would render as "idle" — the same choice
 * `system:device-info` makes for GPU utilisation.
 */

import { t } from 'elysia';
import os from 'node:os';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries';
import { requireProjectAccess } from '../access';
import { ptyKitManager } from '../../terminal/ptykit';
import si from 'systeminformation';
import { debug } from '$shared/utils/logger';

/** Ceiling on entries visited by one walk, so a monorepo cannot pin a core. */
const MAX_ENTRIES = 300_000;
/** Wall-clock ceiling on one walk — the backstop for slow disks and network mounts. */
const WALK_DEADLINE_MS = 15_000;
/** How many `stat` calls are in flight at once while walking one directory. */
const STAT_BATCH = 64;
/** A folder's size changes slowly; a poll should not re-walk it every tick. */
const STORAGE_CACHE_TTL_MS = 15_000;
/**
 * An expensive walk earns a proportionally longer rest: a tree that takes ten
 * seconds to measure would otherwise be re-walked the moment its answer went
 * stale, leaving one core busy for as long as the panel stays open.
 */
const STORAGE_TTL_PER_MS_SPENT = 4;
const STORAGE_CACHE_MAX_TTL_MS = 5 * 60_000;

/**
 * Longer than the 500ms window `si` caches its own process table for, so a
 * cache hit here can never make `si` return a stale table whose CPU delta
 * spans a different interval than our `os.cpus()` snapshot.
 */
const PROCESS_CACHE_TTL_MS = 2_000;
/** `si.processes()` shells out — to PowerShell on Windows, which can hang. */
const PROCESS_PROBE_TIMEOUT_MS = 10_000;

// ── Storage ──────────────────────────────────────────────────────────────────

interface FolderStats {
	sizeBytes: number;
	fileCount: number;
	dirCount: number;
	truncated: boolean;
	error?: string;
}

const storageCache = new Map<string, { stats: FolderStats; at: number; ttl: number }>();
const storageInFlight = new Map<string, Promise<FolderStats>>();

/**
 * Cached *and* single-flighted.
 *
 * Single-flight is the load-bearing half: a walk of a large project takes far
 * longer than the panel's poll interval, and a result-only cache is still empty
 * while the first walk runs, so every poll would start another full walk and
 * they would pile up faster than they finish.
 */
function getFolderStats(root: string): Promise<FolderStats> {
	const cached = storageCache.get(root);
	if (cached && Date.now() - cached.at < cached.ttl) {
		return Promise.resolve(cached.stats);
	}

	const inFlight = storageInFlight.get(root);
	if (inFlight) return inFlight;

	const startedAt = Date.now();
	const walk = walkFolder(root)
		.catch((e): FolderStats => ({
			sizeBytes: 0,
			fileCount: 0,
			dirCount: 0,
			truncated: false,
			error: e instanceof Error ? e.message : String(e)
		}))
		.then((stats) => {
			const spent = Date.now() - startedAt;
			const ttl = Math.min(
				STORAGE_CACHE_MAX_TTL_MS,
				Math.max(STORAGE_CACHE_TTL_MS, spent * STORAGE_TTL_PER_MS_SPENT)
			);
			storageCache.set(root, { stats, at: Date.now(), ttl });
			storageInFlight.delete(root);
			return stats;
		});

	storageInFlight.set(root, walk);
	return walk;
}

async function walkFolder(root: string): Promise<FolderStats> {
	try {
		const rootStat = await stat(root);
		if (!rootStat.isDirectory()) {
			return { sizeBytes: rootStat.size, fileCount: 1, dirCount: 0, truncated: false };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { sizeBytes: 0, fileCount: 0, dirCount: 0, truncated: false, error: msg };
	}

	const deadline = Date.now() + WALK_DEADLINE_MS;
	const stack: string[] = [root];
	let sizeBytes = 0;
	let fileCount = 0;
	let dirCount = 0;
	let truncated = false;

	while (stack.length > 0) {
		if (fileCount + dirCount >= MAX_ENTRIES || Date.now() > deadline) {
			truncated = true;
			break;
		}

		const dir = stack.pop()!;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			// Unreadable directory (permissions, vanished mid-walk) — skip it.
			continue;
		}

		const files: string[] = [];
		for (const entry of entries) {
			if (fileCount + dirCount >= MAX_ENTRIES) {
				truncated = true;
				break;
			}
			// Symlinks and Windows junctions are not followed: they would double
			// count their target at best and loop forever at worst.
			if (entry.isSymbolicLink()) continue;

			if (entry.isDirectory()) {
				dirCount++;
				stack.push(join(dir, entry.name));
			} else if (entry.isFile()) {
				fileCount++;
				files.push(join(dir, entry.name));
			}
		}

		// One `stat` per file is unavoidable — no platform reports sizes from a
		// directory read — but they need not be serialised.
		for (let i = 0; i < files.length; i += STAT_BATCH) {
			const sizes = await Promise.all(
				files.slice(i, i + STAT_BATCH).map((file) => stat(file).then((s) => s.size, () => 0))
			);
			for (const size of sizes) sizeBytes += size;
		}
	}

	return { sizeBytes, fileCount, dirCount, truncated };
}

// ── Process table ────────────────────────────────────────────────────────────

export interface ProbedProcess {
	pid: number;
	parentPid: number;
	name: string;
	cpu: number;
	memRss: number;
	command: string;
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

/**
 * The multiplier that turns one `si` CPU percentage into a share of total
 * machine capacity. `null` when no honest conversion exists yet — see the
 * module header for why each platform needs a different one.
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

interface ProcessProbe {
	list: ProbedProcess[];
	factor: number | null;
}

let cachedProbe: { probe: ProcessProbe | null; at: number } | null = null;
let inFlightProbe: Promise<ProcessProbe | null> | null = null;
let lastCpuTicks: { busy: number; total: number } | null = null;
let probeCount = 0;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	return Promise.race([promise, timeout])
		.then((value) => {
			clearTimeout(timer);
			return value;
		})
		.catch(() => {
			clearTimeout(timer);
			return null;
		});
}

async function probeProcesses(): Promise<ProcessProbe | null> {
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
		debug.warn('project', 'si.processes() unavailable — reporting resources as unknown');
		lastCpuTicks = null;
		probeCount = 0;
		return null;
	}

	probeCount++;
	const factor = cpuCapacityFactor(process.platform, os.cpus().length, busyFraction, probeCount >= 2);

	const list: ProbedProcess[] = (result.list ?? []).map((p) => ({
		pid: p.pid,
		parentPid: p.parentPid,
		name: p.name,
		cpu: typeof p.cpu === 'number' && Number.isFinite(p.cpu) ? p.cpu : 0,
		// `si` reports RSS in KB on every platform.
		memRss: typeof p.memRss === 'number' && Number.isFinite(p.memRss) ? p.memRss : 0,
		command: p.command
	}));

	return { list, factor };
}

/** Cached and single-flighted: N panels polling in step cost one probe. */
function getProcessProbe(): Promise<ProcessProbe | null> {
	if (cachedProbe && Date.now() - cachedProbe.at < PROCESS_CACHE_TTL_MS) {
		return Promise.resolve(cachedProbe.probe);
	}
	if (inFlightProbe) return inFlightProbe;

	inFlightProbe = probeProcesses().then((probe) => {
		cachedProbe = { probe, at: Date.now() };
		inFlightProbe = null;
		return probe;
	});
	return inFlightProbe;
}

interface ProjectProcess {
	pid: number;
	parentPid: number;
	name: string;
	cpuPercent: number | null;
	memRssBytes: number;
	command: string;
}

interface ProcessStats {
	status: 'running' | 'not_running';
	cpuPercent: number | null;
	memRssBytes: number | null;
	memPercent: number | null;
	processCount: number;
	processes: ProjectProcess[];
	rootPids: number[];
}

const IDLE: ProcessStats = {
	status: 'not_running',
	cpuPercent: 0,
	memRssBytes: 0,
	memPercent: 0,
	processCount: 0,
	processes: [],
	rootPids: []
};

async function getProjectProcessStats(projectId: string): Promise<ProcessStats> {
	const rootPids = ptyKitManager
		.list(projectId)
		.filter((session) => session.status === 'active')
		.map((session) => session.pid)
		.filter((pid) => Number.isFinite(pid) && pid > 0);

	// No shells means nothing of this project is running, and zero is the truth
	// rather than a stand-in for a number we failed to read.
	if (rootPids.length === 0) return IDLE;

	const probe = await getProcessProbe();

	// Shells are alive but the host's process table is unreadable, or none of
	// them are visible in it yet. Either way the usage is unknown, not zero.
	if (!probe || probe.list.length === 0) {
		return {
			status: 'running',
			cpuPercent: null,
			memRssBytes: null,
			memPercent: null,
			processCount: 0,
			processes: [],
			rootPids
		};
	}

	const tree = collectProcessTree(probe.list, rootPids);
	const matched = probe.list.filter((p) => tree.has(p.pid));

	if (matched.length === 0) {
		return {
			status: 'running',
			cpuPercent: null,
			memRssBytes: null,
			memPercent: null,
			processCount: 0,
			processes: [],
			rootPids
		};
	}

	const factor = probe.factor;
	let cpuPercent = factor === null ? null : 0;
	let memRssBytes = 0;
	for (const proc of matched) {
		if (cpuPercent !== null && factor !== null) cpuPercent += proc.cpu * factor;
		memRssBytes += proc.memRss * 1024;
	}
	if (cpuPercent !== null) cpuPercent = Math.min(100, Math.max(0, cpuPercent));

	const totalMem = os.totalmem();

	return {
		status: 'running',
		cpuPercent,
		memRssBytes,
		// Derived from the bytes above so the two figures can never disagree.
		memPercent: totalMem > 0 ? (memRssBytes / totalMem) * 100 : null,
		processCount: matched.length,
		processes: matched
			.slice()
			.sort((a, b) => b.cpu - a.cpu)
			.slice(0, 20)
			.map((p) => ({
				pid: p.pid,
				parentPid: p.parentPid,
				name: p.name,
				cpuPercent: factor === null ? null : Math.min(100, Math.max(0, p.cpu * factor)),
				memRssBytes: p.memRss * 1024,
				command: p.command
			})),
		rootPids
	};
}

// ── Handler ──────────────────────────────────────────────────────────────────

const nullableNumber = t.Union([t.Number(), t.Null()]);

export const infoHandler = createRouter().http(
	'projects:info',
	{
		data: t.Object({
			id: t.String({ minLength: 1 })
		}),
		response: t.Object({
			project: t.Any(),
			storage: t.Object({
				sizeBytes: t.Number(),
				fileCount: t.Number(),
				dirCount: t.Number(),
				truncated: t.Boolean(),
				error: t.Optional(t.String())
			}),
			resources: t.Object({
				status: t.Union([t.Literal('running'), t.Literal('not_running')]),
				cpuPercent: nullableNumber,
				memRssBytes: nullableNumber,
				memPercent: nullableNumber,
				processCount: t.Number(),
				rootPids: t.Array(t.Number()),
				processes: t.Array(
					t.Object({
						pid: t.Number(),
						parentPid: t.Number(),
						name: t.String(),
						cpuPercent: nullableNumber,
						memRssBytes: t.Number(),
						command: t.String()
					})
				)
			}),
			meta: t.Object({
				platform: t.String(),
				arch: t.String(),
				logicalCores: t.Number()
			})
		})
	},
	async ({ data, conn }) => {
		requireProjectAccess(conn, data.id);
		const project = projectQueries.getById(data.id);
		if (!project) {
			throw new Error('Project not found');
		}

		const [storage, resources] = await Promise.all([
			getFolderStats(project.path),
			getProjectProcessStats(data.id)
		]);

		return {
			project,
			storage,
			resources,
			meta: {
				platform: process.platform,
				arch: process.arch,
				logicalCores: os.cpus().length
			}
		};
	}
);
