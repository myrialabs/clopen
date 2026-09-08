/**
 * Projects Overview — read-only recap of projects with per-project resources.
 *
 * Separate from `system:device-info` (host hardware, polls every ~3.5s) and
 * from `projects:info` (one project's storage + live CPU/RAM/ports).
 *
 * This endpoint answers:
 * - how many projects exist / how many are idle / how many measurable
 * - summed folder stats over measurable idle projects
 * - top 5 projects by folder size, each with the same CPU/RAM/storage
 *   figures `projects:info` (Project Info modal) reports
 *
 * Definitions (same as Project Info):
 * - idle    = `projectShellPids(projectId).length === 0` (no active PTY shell)
 * - running = at least one active shell
 *
 * Storage comes from the shared `getFolderStats()` in `./info` and CPU/RAM
 * from the shared `getProjectProcessStats()` in the same module — the same
 * walks, caches, and process table Project Info uses — so the two panels
 * cannot disagree about one project. Entries whose walk reports `error`
 * (folder moved/deleted/unreadable) are excluded from totals and from Top 5
 * but still counted in `idleCount` and listed under `unmeasurable` so the UI
 * can render an honest footnote.
 *
 * Cost control:
 * - no port scan and no per-process list here, only the summed CPU/RAM
 * - overview-level TTL cache (3s, matching the frontend heartbeat) +
 *   single-flight, on top of the per-path storage cache and the shared
 *   process-table cache, so repeated calls never repeat folder walks; at
 *   most one process-table probe per rebuild
 * - the Device poll is a frontend concern; this handler just makes frequent
 *   polling cheap. Frontend polls it on its own 3s heartbeat.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries';
import { projectShellPids } from '../../projects/shell-ownership';
import { getHostFacts } from '../../host/metrics';
import { getFolderStats, getProjectProcessStats, type FolderStats } from './info';

export type ProjectResourceStatus = 'running' | 'idle';

/** Fresh response snapshot; never mutated after caching. */
export interface TopEntry {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
	status: ProjectResourceStatus;
	cpuPercent: number | null;
	memRssBytes: number | null;
	memPercent: number | null;
	sizeBytes: number;
	fileCount: number;
	dirCount: number;
	truncated: boolean;
}

export interface UnmeasurableEntry {
	id: string;
	name: string;
	path: string;
	error: string;
}

export interface ProjectsOverview {
	totalProjects: number;
	runningCount: number;
	idleCount: number;
	measurableCount: number;
	unmeasurableCount: number;
	totalStorageIdle: number;
	totalFilesIdle: number;
	totalDirsIdle: number;
	top: TopEntry[];
	unmeasurable: UnmeasurableEntry[];
	generatedAt: string;
}

export interface ProjectEntry {
	id: string;
	name: string;
	path: string;
	created_at: string;
	last_opened_at: string;
	status: ProjectResourceStatus;
	cpuPercent: number | null;
	memRssBytes: number | null;
	memPercent: number | null;
	storage: FolderStats;
}

/** Sum folder stats over measurable (error-free) idle entries only. */
export function summarizeIdleStats(entries: Array<{ status: ProjectResourceStatus; storage: FolderStats }>): {
	measurableCount: number;
	totalStorageIdle: number;
	totalFilesIdle: number;
	totalDirsIdle: number;
} {
	let measurableCount = 0;
	let totalStorageIdle = 0;
	let totalFilesIdle = 0;
	let totalDirsIdle = 0;
	for (const entry of entries) {
		if (entry.status !== 'idle' || entry.storage.error) continue;
		measurableCount++;
		totalStorageIdle += entry.storage.sizeBytes;
		totalFilesIdle += entry.storage.fileCount;
		totalDirsIdle += entry.storage.dirCount;
	}
	return { measurableCount, totalStorageIdle, totalFilesIdle, totalDirsIdle };
}

/** Top entries by folder size across every status; error entries never rank. */
export function pickTopEntries(entries: ProjectEntry[], limit = 5): ProjectEntry[] {
	return entries
		.filter((entry) => !entry.storage.error)
		.sort((a, b) => {
			if (b.storage.sizeBytes !== a.storage.sizeBytes) {
				return b.storage.sizeBytes - a.storage.sizeBytes;
			}
			return a.last_opened_at.localeCompare(b.last_opened_at);
		})
		.slice(0, limit);
}

/** Overview-level cache: one snapshot serves every caller inside the TTL.
 *  Kept at the frontend 3s heartbeat so counts and Running/Idle flips go
 *  live without a manual refresh. Rebuilds stay cheap: folder walks keep
 *  their own cache and a rebuild costs at most one process-table probe. */
const OVERVIEW_CACHE_TTL_MS = 3_000;
let cachedOverview: { payload: ProjectsOverview; at: number } | null = null;
let inFlightOverview: Promise<ProjectsOverview> | null = null;

async function buildOverview(): Promise<ProjectsOverview> {
	const projects = projectQueries.getAll();

	const idleIds = new Set<string>();
	for (const project of projects) {
		if (projectShellPids(project.id).length === 0) idleIds.add(project.id);
	}

	// All three phases launch together. They used to await one after another
	// (facts ~4s, walks ~20s, process probe ~10s worst case), which stacked
	// past the client's timeout on a loaded machine. Concurrent, the slowest
	// single phase bounds the total instead of their sum.
	const factsP = getHostFacts();
	const storagesP = Promise.all(projects.map((project) => getFolderStats(project.path)));
	const resourcesP = factsP.then((facts) =>
		Promise.all(
			projects.map((project) =>
				idleIds.has(project.id)
					? Promise.resolve({ cpuPercent: 0, memRssBytes: 0, memPercent: 0 })
					: getProjectProcessStats(project.id, facts.totalMemBytes).then((stats) => ({
							cpuPercent: stats.cpuPercent,
							memRssBytes: stats.memRssBytes,
							memPercent: stats.memPercent
						}))
			)
		)
	);

	const [storages, resources] = await Promise.all([storagesP, resourcesP]);

	const entries: ProjectEntry[] = projects.map((project, i) => ({
		id: project.id,
		name: project.name,
		path: project.path,
		created_at: project.created_at,
		last_opened_at: project.last_opened_at,
		status: idleIds.has(project.id) ? 'idle' : 'running',
		cpuPercent: resources[i].cpuPercent,
		memRssBytes: resources[i].memRssBytes,
		memPercent: resources[i].memPercent,
		storage: storages[i]
	}));

	const idleCount = idleIds.size;
	const totals = summarizeIdleStats(entries);
	const top = pickTopEntries(entries, 5).map((entry) => ({
		id: entry.id,
		name: entry.name,
		path: entry.path,
		created_at: entry.created_at,
		last_opened_at: entry.last_opened_at,
		status: entry.status,
		cpuPercent: entry.cpuPercent,
		memRssBytes: entry.memRssBytes,
		memPercent: entry.memPercent,
		sizeBytes: entry.storage.sizeBytes,
		fileCount: entry.storage.fileCount,
		dirCount: entry.storage.dirCount,
		truncated: entry.storage.truncated
	}));

	const unmeasurable: UnmeasurableEntry[] = entries
		.filter((entry) => entry.storage.error)
		.map((entry) => ({
			id: entry.id,
			name: entry.name,
			path: entry.path,
			error: entry.storage.error as string
		}));

	return {
		totalProjects: projects.length,
		runningCount: projects.length - idleCount,
		idleCount,
		measurableCount: totals.measurableCount,
		unmeasurableCount: unmeasurable.length,
		totalStorageIdle: totals.totalStorageIdle,
		totalFilesIdle: totals.totalFilesIdle,
		totalDirsIdle: totals.totalDirsIdle,
		top,
		unmeasurable,
		generatedAt: new Date().toISOString()
	};
}

function getOverview(): Promise<ProjectsOverview> {
	if (cachedOverview && Date.now() - cachedOverview.at < OVERVIEW_CACHE_TTL_MS) {
		return Promise.resolve(cachedOverview.payload);
	}
	if (inFlightOverview) return inFlightOverview;

	inFlightOverview = buildOverview().then((payload) => {
		cachedOverview = { payload, at: Date.now() };
		inFlightOverview = null;
		return payload;
	});
	// A failed build must not pin the single-flight slot; the per-path
	// storage layer already converts walk failures into error stats, so a
	// rejection here is unexpected (e.g. DB unreadable) and should retry.
	inFlightOverview.then(
		() => {},
		() => {
			inFlightOverview = null;
		}
	);
	return inFlightOverview;
}

const nullableNumber = t.Union([t.Number(), t.Null()]);

const TopEntrySchema = t.Object({
	id: t.String(),
	name: t.String(),
	path: t.String(),
	created_at: t.String(),
	last_opened_at: t.String(),
	status: t.Union([t.Literal('running'), t.Literal('idle')]),
	cpuPercent: nullableNumber,
	memRssBytes: nullableNumber,
	memPercent: nullableNumber,
	sizeBytes: t.Number(),
	fileCount: t.Number(),
	dirCount: t.Number(),
	truncated: t.Boolean()
});

export const overviewHandler = createRouter().http(
	'projects:overview',
	{
		data: t.Object({}),
		response: t.Object({
			totalProjects: t.Number(),
			runningCount: t.Number(),
			idleCount: t.Number(),
			measurableCount: t.Number(),
			unmeasurableCount: t.Number(),
			totalStorageIdle: t.Number(),
			totalFilesIdle: t.Number(),
			totalDirsIdle: t.Number(),
			top: t.Array(TopEntrySchema),
			unmeasurable: t.Array(
				t.Object({
					id: t.String(),
					name: t.String(),
					path: t.String(),
					error: t.String()
				})
			),
			generatedAt: t.String()
		})
	},
	async () => getOverview()
);
