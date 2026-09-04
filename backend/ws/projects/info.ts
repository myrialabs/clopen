/**
 * Projects Info — what one project costs on this machine.
 *
 * Storage is a bounded walk of the project folder, nothing excluded. CPU and
 * RAM come from the shared host probe in `backend/host/metrics.ts`, narrowed to
 * the project's PTY shells and their descendants, so they sit on the same basis
 * Settings → Device reports for the whole machine. Engine processes Clopen runs
 * outside a terminal are not shells and do not appear here.
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
/** Wall-clock ceiling — the backstop for slow disks and network mounts. */
const WALK_DEADLINE_MS = 15_000;
/** How many `stat` calls are in flight at once while walking one directory. */
const STAT_BATCH = 64;
/** A folder's size changes slowly; a poll should not re-walk it every tick. */
const STORAGE_CACHE_TTL_MS = 15_000;
/** An expensive walk earns a longer rest, so it is not repeated the moment its
 *  answer goes stale — otherwise one core stays busy while the panel is open. */
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

/** Cached and single-flighted: a big walk outlives the poll interval, so a
 *  result-only cache would let every tick start another one. */
function getFolderStats(root: string): Promise<FolderStats> {
	const cached = storageCache.get(root);
	if (cached && Date.now() - cached.at < cached.ttl) {
		return Promise.resolve(cached.stats);
	}

	const inFlight = storageInFlight.get(root);
	if (inFlight) return inFlight;

	const startedAt = Date.now();
	const walk = walkFolder(root)
		.catch((error): FolderStats => ({
			sizeBytes: 0,
			fileCount: 0,
			dirCount: 0,
			truncated: false,
			error: error instanceof Error ? error.message : String(error)
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
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { sizeBytes: 0, fileCount: 0, dirCount: 0, truncated: false, error: message };
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
			// Symlinks and Windows junctions: double-counted at best, a loop at worst.
			if (entry.isSymbolicLink()) continue;

			if (entry.isDirectory()) {
				dirCount++;
				stack.push(join(dir, entry.name));
			} else if (entry.isFile()) {
				fileCount++;
				files.push(join(dir, entry.name));
			}
		}

		// No platform reports sizes from a directory read, so one `stat` per file
		// is unavoidable — but they need not be serialised.
		for (let offset = 0; offset < files.length; offset += STAT_BATCH) {
			const sizes = await Promise.all(
				files.slice(offset, offset + STAT_BATCH).map((file) => stat(file).then((info) => info.size, () => 0))
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

	// No shells means nothing is running, so zero is the truth here.
	if (rootPids.length === 0) return IDLE;

	const probe = await getProcessTable();

	// Shells are alive but the host table is unreadable — unknown, not zero.
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
	const matched = probe.list.filter((entry) => tree.has(entry.pid));

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
	for (const entry of matched) {
		if (cpuPercent !== null && factor !== null) cpuPercent += entry.cpu * factor;
		memRssBytes += entry.memRss * 1024;
	}
	if (cpuPercent !== null) cpuPercent = Math.min(100, Math.max(0, cpuPercent));

	return {
		status: 'running',
		cpuPercent,
		memRssBytes,
		// Same installed-RAM figure Settings -> Device divides by.
		memPercent: totalMemBytes > 0 ? (memRssBytes / totalMemBytes) * 100 : null,
		processCount: matched.length,
		processes: matched
			.slice()
			.sort((a, b) => b.cpu - a.cpu)
			.slice(0, 20)
			.map((entry) => ({
				pid: entry.pid,
				parentPid: entry.parentPid,
				name: entry.name,
				cpuPercent: factor === null ? null : Math.min(100, Math.max(0, entry.cpu * factor)),
				memRssBytes: entry.memRss * 1024,
				command: entry.command
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

		// Probed once per process, so only the first caller pays.
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
