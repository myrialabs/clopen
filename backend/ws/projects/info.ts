/**
 * Projects Info — what one project costs on this machine.
 *
 * Storage is measured here; CPU and RAM are read from the shared host probe in
 * `backend/host/metrics.ts` and then narrowed to this project, so the figures
 * sit on the same basis as the ones Settings → Device reports for the whole
 * machine.
 *
 * - Storage: a recursive walk of `project.path`. Nothing is excluded — `.git`
 *   and `node_modules` are part of what the folder actually occupies — so the
 *   walk is stopped by whichever of `MAX_ENTRIES` or `WALK_DEADLINE_MS` comes
 *   first and reports `truncated` when it was. Both bounds are shared between
 *   concurrent callers, so N open panels cost one walk rather than N.
 * - CPU/RAM: the PTY shells Clopen opened for this project plus every live
 *   descendant of them. Nothing else on the host is counted, so this is the
 *   project's own footprint and not the server's. Engine processes that Clopen
 *   runs outside a terminal are not shells and do not appear here.
 */

import { t } from 'elysia';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries';
import { requireProjectAccess } from '../access';
import { ptyKitManager } from '../../terminal/ptykit';
import { collectProcessTree, getHostFacts, getProcessTable } from '../../host/metrics';

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

// ── Per-project slice of the host process table ──────────────────────────────

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

async function getProjectProcessStats(projectId: string, totalMemBytes: number): Promise<ProcessStats> {
	const rootPids = ptyKitManager
		.list(projectId)
		.filter((session) => session.status === 'active')
		.map((session) => session.pid)
		.filter((pid) => Number.isFinite(pid) && pid > 0);

	// No shells means nothing of this project is running, and zero is the truth
	// rather than a stand-in for a number we failed to read.
	if (rootPids.length === 0) return IDLE;

	const probe = await getProcessTable();

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

	const factor = probe.cpuFactor;
	let cpuPercent = factor === null ? null : 0;
	let memRssBytes = 0;
	for (const proc of matched) {
		if (cpuPercent !== null && factor !== null) cpuPercent += proc.cpu * factor;
		memRssBytes += proc.memRss * 1024;
	}
	if (cpuPercent !== null) cpuPercent = Math.min(100, Math.max(0, cpuPercent));

	return {
		status: 'running',
		cpuPercent,
		memRssBytes,
		// Derived from the bytes above, against the same installed-RAM figure
		// Settings -> Device reports, so no two panels can disagree on the total.
		memPercent: totalMemBytes > 0 ? (memRssBytes / totalMemBytes) * 100 : null,
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

		// Host facts are probed once per process and cached, so only the first
		// caller pays for them; every panel then reads the same numbers.
		const facts = await getHostFacts();

		const [storage, resources] = await Promise.all([
			getFolderStats(project.path),
			getProjectProcessStats(data.id, facts.totalMemBytes)
		]);

		return {
			project,
			storage,
			resources,
			meta: {
				platform: facts.platform,
				arch: facts.arch,
				logicalCores: facts.logicalCores
			}
		};
	}
);
