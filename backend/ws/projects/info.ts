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
import { projectShellPids } from '../../projects/shell-ownership';
import { portMonitor } from '../../ports/monitor';
import { LOCAL_PORT_HOST, type PortEntry } from '$shared/types/ports';
import { debug } from '$shared/utils/logger';
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
/** A scan reads the socket table and the process list; the panel polls faster. */
const PORTS_CACHE_TTL_MS = 5_000;

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
	const rootPids = projectShellPids(projectId);

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

// ── Ports ────────────────────────────────────────────────────────────────────

export interface ProjectPort {
	port: number;
	protocol: string;
	label: string;
	publicUrl: string | null;
}

let cachedPorts: { entries: Map<string, ProjectPort[]>; at: number } | null = null;
let inFlightPorts: Promise<Map<string, ProjectPort[]>> | null = null;

/**
 * Ports the local scan already attributed to a project, grouped by project id.
 *
 * The attribution is the port manager's, not a second guess: it climbs from the
 * listening pid to a terminal session using the same shell roots this handler
 * descends from. Ports a container publishes are the runtime's, not a shell's,
 * so they carry no project and do not appear here.
 */
export function groupPortsByProject(entries: PortEntry[]): Map<string, ProjectPort[]> {
	const byProject = new Map<string, ProjectPort[]>();

	for (const entry of entries) {
		const projectId = entry.origin.projectId;
		// A container's published port belongs to the runtime, not to a shell.
		if (entry.origin.kind !== 'session' || !projectId) continue;
		const list = byProject.get(projectId) ?? [];
		list.push({
			port: entry.port,
			protocol: entry.protocol,
			label: entry.origin.label,
			publicUrl: entry.publicUrl
		});
		byProject.set(projectId, list);
	}

	return byProject;
}

async function scanProjectPorts(): Promise<Map<string, ProjectPort[]>> {
	try {
		const scan = await portMonitor.scanOnce(LOCAL_PORT_HOST);
		return groupPortsByProject(scan.entries);
	} catch (error) {
		// A panel that cannot list ports still reports storage and usage.
		debug.warn('project', 'port scan failed for project info:', error);
		return new Map();
	}
}

/** Cached and single-flighted — one scan serves every open panel. */
function getProjectPorts(projectId: string): Promise<ProjectPort[]> {
	const pick = (entries: Map<string, ProjectPort[]>) =>
		(entries.get(projectId) ?? []).sort((left, right) => left.port - right.port);

	if (cachedPorts && Date.now() - cachedPorts.at < PORTS_CACHE_TTL_MS) {
		return Promise.resolve(pick(cachedPorts.entries));
	}
	if (inFlightPorts) return inFlightPorts.then(pick);

	inFlightPorts = scanProjectPorts().then((entries) => {
		cachedPorts = { entries, at: Date.now() };
		inFlightPorts = null;
		return entries;
	});
	return inFlightPorts.then(pick);
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
			ports: t.Array(
				t.Object({
					port: t.Number(),
					protocol: t.String(),
					label: t.String(),
					publicUrl: t.Union([t.String(), t.Null()])
				})
			),
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

		const [storage, resources, ports] = await Promise.all([
			getFolderStats(project.path),
			getProjectProcessStats(data.id, facts.totalMemBytes),
			getProjectPorts(data.id)
		]);

		return {
			project,
			storage,
			resources,
			ports,
			meta: {
				platform: facts.platform,
				arch: facts.arch,
				logicalCores: facts.logicalCores
			}
		};
	}
);
