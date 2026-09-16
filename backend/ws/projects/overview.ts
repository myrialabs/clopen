/**
 * Projects Overview — per-project resource usage for every project at once.
 *
 * Settings -> Device already describes the machine; this is the same question
 * asked per project, so an admin can see where the machine's CPU, RAM and disk
 * actually went without opening Project Info once per project.
 *
 * Separate from `system:device-info` (host hardware) and from `projects:info`
 * (one project's storage, live CPU/RAM, process list and ports). The figures
 * come from the same two sources `projects:info` reads — `peekFolderStats()`
 * and `getProjectProcessStats()` in `./info` — so the panel and the modal
 * cannot disagree about one project.
 *
 * Definitions (same as Project Info):
 * - idle    = `projectShellPids(projectId).length === 0` (no active PTY shell)
 * - running = at least one active shell
 *
 * Access: scoped to the caller. Admins see every project, everyone else sees
 * only the projects they are assigned to — the same rule `projects:info`
 * enforces per project through `requireProjectAccess`.
 *
 * Cost control:
 * - no port scan and no per-process list here, only the summed CPU/RAM
 * - storage is read from cache and never awaited: a cold folder reports
 *   `measuring` and fills in on a later poll, so this handler's latency is
 *   the process-table probe, not a filesystem walk
 * - one snapshot per scope is cached for `OVERVIEW_CACHE_TTL_MS` and
 *   single-flighted, and the process table underneath has its own 2s cache,
 *   so a fast poll costs at most one probe every couple of seconds
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import { projectQueries } from '../../database/queries';
import { projectShellPids } from '../../projects/shell-ownership';
import { getHostFacts } from '../../host/metrics';
import { getProjectProcessStats, peekFolderStats } from './info';
import type { Project } from '$shared/types/database/schema';

export type ProjectResourceStatus = 'running' | 'idle';

/**
 * `ready`       — the folder was walked and the numbers below are its answer.
 * `measuring`   — no walk has finished yet; the numbers are zero, not a total.
 * `unavailable` — the folder moved, was deleted, or cannot be read.
 */
export type StorageState = 'ready' | 'measuring' | 'unavailable';

export interface ProjectStorage {
	state: StorageState;
	sizeBytes: number;
	fileCount: number;
	dirCount: number;
	/** The walk hit its entry ceiling or deadline, so the size is a floor. */
	truncated: boolean;
	error: string | null;
}

export interface ProjectResourceEntry {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
	status: ProjectResourceStatus;
	cpuPercent: number | null;
	memRssBytes: number | null;
	memPercent: number | null;
	storage: ProjectStorage;
}

export interface ProjectsOverview {
	totalProjects: number;
	runningCount: number;
	idleCount: number;
	measuredCount: number;
	measuringCount: number;
	unavailableCount: number;
	/** Summed over `ready` entries only, so a pending walk never reads as 0 B. */
	totalStorageBytes: number;
	totalFiles: number;
	totalDirs: number;
	projects: ProjectResourceEntry[];
	generatedAt: string;
}

const MEASURING: ProjectStorage = {
	state: 'measuring',
	sizeBytes: 0,
	fileCount: 0,
	dirCount: 0,
	truncated: false,
	error: null
};

/** Sum folder stats over entries whose walk actually produced an answer. */
export function summarizeStorage(entries: Array<{ storage: ProjectStorage }>): {
	measuredCount: number;
	measuringCount: number;
	unavailableCount: number;
	totalStorageBytes: number;
	totalFiles: number;
	totalDirs: number;
} {
	let measuredCount = 0;
	let measuringCount = 0;
	let unavailableCount = 0;
	let totalStorageBytes = 0;
	let totalFiles = 0;
	let totalDirs = 0;

	for (const entry of entries) {
		if (entry.storage.state === 'measuring') {
			measuringCount++;
			continue;
		}
		if (entry.storage.state === 'unavailable') {
			unavailableCount++;
			continue;
		}
		measuredCount++;
		totalStorageBytes += entry.storage.sizeBytes;
		totalFiles += entry.storage.fileCount;
		totalDirs += entry.storage.dirCount;
	}

	return { measuredCount, measuringCount, unavailableCount, totalStorageBytes, totalFiles, totalDirs };
}

/** Rank order for the panel: biggest first, then the ones still being measured,
 *  then the folders that cannot be read. Equal sizes fall back to the project
 *  left untouched longest, which is the one worth looking at first. */
const STATE_RANK: Record<StorageState, number> = { ready: 0, measuring: 1, unavailable: 2 };

export function sortByFootprint<T extends ProjectResourceEntry>(entries: T[]): T[] {
	return entries.slice().sort((a, b) => {
		if (STATE_RANK[a.storage.state] !== STATE_RANK[b.storage.state]) {
			return STATE_RANK[a.storage.state] - STATE_RANK[b.storage.state];
		}
		if (b.storage.sizeBytes !== a.storage.sizeBytes) {
			return b.storage.sizeBytes - a.storage.sizeBytes;
		}
		return a.last_opened_at.localeCompare(b.last_opened_at);
	});
}

function readStorage(path: string): ProjectStorage {
	const stats = peekFolderStats(path);
	if (!stats) return MEASURING;
	if (stats.error) {
		return {
			state: 'unavailable',
			sizeBytes: 0,
			fileCount: 0,
			dirCount: 0,
			truncated: false,
			error: stats.error
		};
	}
	return {
		state: 'ready',
		sizeBytes: stats.sizeBytes,
		fileCount: stats.fileCount,
		dirCount: stats.dirCount,
		truncated: stats.truncated,
		error: null
	};
}

async function buildOverview(projects: Project[]): Promise<ProjectsOverview> {
	const idleIds = new Set<string>();
	for (const project of projects) {
		if (projectShellPids(project.id).length === 0) idleIds.add(project.id);
	}

	// Probed once per process, so only the first caller pays.
	const facts = await getHostFacts();

	// Idle means no shell to attribute usage to, so the process table is never
	// consulted for it — on an install where most projects sit idle this is the
	// difference between one probe and none.
	const resources = await Promise.all(
		projects.map((project) =>
			idleIds.has(project.id)
				? Promise.resolve({ cpuPercent: 0, memRssBytes: 0, memPercent: 0 })
				: getProjectProcessStats(project.id, facts.totalMemBytes).then((stats) => ({
						cpuPercent: stats.cpuPercent,
						memRssBytes: stats.memRssBytes,
						memPercent: stats.memPercent
					}))
		)
	);

	const entries: ProjectResourceEntry[] = projects.map((project, i) => ({
		id: project.id,
		name: project.name,
		path: project.path,
		created_at: project.created_at,
		last_opened_at: project.last_opened_at,
		status: idleIds.has(project.id) ? 'idle' : 'running',
		cpuPercent: resources[i].cpuPercent,
		memRssBytes: resources[i].memRssBytes,
		memPercent: resources[i].memPercent,
		storage: readStorage(project.path)
	}));

	const totals = summarizeStorage(entries);

	return {
		totalProjects: projects.length,
		runningCount: projects.length - idleIds.size,
		idleCount: idleIds.size,
		...totals,
		projects: sortByFootprint(entries),
		generatedAt: new Date().toISOString()
	};
}

/** One snapshot per access scope. Kept below the frontend heartbeat so a poll
 *  is never answered with the payload it already has, while burst opens and
 *  rapid tab switches still collapse onto a single build. */
const OVERVIEW_CACHE_TTL_MS = 1_500;
const cachedOverviews = new Map<string, { payload: ProjectsOverview; at: number }>();
const inFlightOverviews = new Map<string, Promise<ProjectsOverview>>();

function getOverview(scope: string, projects: Project[]): Promise<ProjectsOverview> {
	const cached = cachedOverviews.get(scope);
	if (cached && Date.now() - cached.at < OVERVIEW_CACHE_TTL_MS) {
		return Promise.resolve(cached.payload);
	}

	const inFlight = inFlightOverviews.get(scope);
	if (inFlight) return inFlight;

	const build = buildOverview(projects).then((payload) => {
		cachedOverviews.set(scope, { payload, at: Date.now() });
		inFlightOverviews.delete(scope);
		return payload;
	});
	// A failed build must not pin the single-flight slot: storage failures are
	// already folded into `unavailable`, so a rejection here is unexpected
	// (e.g. the process table is unreadable) and the next poll should retry.
	build.catch(() => {
		inFlightOverviews.delete(scope);
	});
	inFlightOverviews.set(scope, build);
	return build;
}

const nullableNumber = t.Union([t.Number(), t.Null()]);

const ProjectEntrySchema = t.Object({
	id: t.String(),
	name: t.String(),
	path: t.String(),
	created_at: t.String(),
	last_opened_at: t.String(),
	status: t.Union([t.Literal('running'), t.Literal('idle')]),
	cpuPercent: nullableNumber,
	memRssBytes: nullableNumber,
	memPercent: nullableNumber,
	storage: t.Object({
		state: t.Union([t.Literal('ready'), t.Literal('measuring'), t.Literal('unavailable')]),
		sizeBytes: t.Number(),
		fileCount: t.Number(),
		dirCount: t.Number(),
		truncated: t.Boolean(),
		error: t.Union([t.String(), t.Null()])
	})
});

export const overviewHandler = createRouter().http(
	'projects:overview',
	{
		data: t.Object({}),
		response: t.Object({
			totalProjects: t.Number(),
			runningCount: t.Number(),
			idleCount: t.Number(),
			measuredCount: t.Number(),
			measuringCount: t.Number(),
			unavailableCount: t.Number(),
			totalStorageBytes: t.Number(),
			totalFiles: t.Number(),
			totalDirs: t.Number(),
			projects: t.Array(ProjectEntrySchema),
			generatedAt: t.String()
		})
	},
	async ({ conn }) => {
		// A project's name and absolute path are not public: every other
		// project-scoped handler goes through `requireProjectAccess`, and a
		// list endpoint has to apply the same rule to the whole list.
		const userId = ws.getUserId(conn);
		const isAdmin = ws.getRole(conn) === 'admin';
		const projects = isAdmin ? projectQueries.getAll() : projectQueries.getAllForUser(userId);
		return getOverview(isAdmin ? 'admin' : `user:${userId}`, projects);
	}
);
