/**
 * Projects Info — per-project resource monitoring
 *
 * Returns storage (folder size) and CPU/RAM computed ONLY from processes
 * belonging to the project. CPU/RAM are NOT host totals.
 *
 * - Storage: recursive walk of project.path (includes .git), capped at 300k entries
 * - CPU/RAM: sum of all processes whose pid is a PTY session pid for this
 *            project (namespace = projectId) OR a descendant via parentPid chain.
 *            If no active PTY sessions, status = not_running and cpu/ram = 0.
 *
 * Poll-safe: storage walk and process list are done in parallel, both are
 * bounded and non-blocking for other requests.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { projectQueries } from '../../database/queries';
import { requireProjectAccess } from '../access';
import { ptyKitManager } from '../../terminal/ptykit';
import si from 'systeminformation';
import { debug } from '$shared/utils/logger';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_ENTRIES = 300_000;
const STORAGE_CACHE_TTL_MS = 15_000;
const storageCache = new Map<string, { stats: FolderStats; at: number }>();

interface FolderStats {
	sizeBytes: number;
	fileCount: number;
	dirCount: number;
	truncated: boolean;
	error?: string;
}

async function getFolderStatsCached(root: string): Promise<FolderStats> {
	const cached = storageCache.get(root);
	if (cached && Date.now() - cached.at < STORAGE_CACHE_TTL_MS) {
		return cached.stats;
	}
	const stats = await getFolderStatsUncached(root);
	storageCache.set(root, { stats, at: Date.now() });
	return stats;
}

async function getFolderStatsUncached(root: string): Promise<FolderStats> {
	let sizeBytes = 0;
	let fileCount = 0;
	let dirCount = 0;
	let truncated = false;

	// Verify root exists
	try {
		const rootStat = await stat(root);
		if (!rootStat.isDirectory()) {
			return { sizeBytes: rootStat.size, fileCount: 1, dirCount: 0, truncated: false };
		}
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { sizeBytes: 0, fileCount: 0, dirCount: 0, truncated: false, error: msg };
	}

	const stack: string[] = [root];

	while (stack.length > 0) {
		if (fileCount + dirCount > MAX_ENTRIES) {
			truncated = true;
			break;
		}
		const dir = stack.pop()!;
		let entries: import('node:fs').Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (fileCount + dirCount > MAX_ENTRIES) {
				truncated = true;
				break;
			}
			const fullPath = join(dir, entry.name);
			try {
				// Symbolic links: do not follow to avoid cycles
				if (entry.isSymbolicLink()) continue;

				if (entry.isDirectory()) {
					dirCount++;
					stack.push(fullPath);
				} else if (entry.isFile()) {
					fileCount++;
					try {
						const st = await stat(fullPath);
						sizeBytes += st.size;
					} catch {
						// ignore unreadable files
					}
				}
			} catch {
				// ignore
			}
		}
	}

	return { sizeBytes, fileCount, dirCount, truncated };
}

interface ProcessStats {
	status: 'running' | 'not_running';
	cpuPercent: number;
	memRssBytes: number;
	memPercent: number;
	processCount: number;
	processes: Array<{
		pid: number;
		parentPid: number;
		name: string;
		cpu: number;
		mem: number;
		memRss: number;
		command: string;
	}>;
	rootPids: number[];
}

async function getProjectProcessStats(projectId: string): Promise<ProcessStats> {
	const sessions = ptyKitManager.list(projectId);
	const active = sessions.filter((s) => s.status === 'active');
	const rootPids = active.map((s) => s.pid).filter((pid) => Number.isFinite(pid) && pid > 0);

	if (rootPids.length === 0) {
		return {
			status: 'not_running',
			cpuPercent: 0,
			memRssBytes: 0,
			memPercent: 0,
			processCount: 0,
			processes: [],
			rootPids: []
		};
	}

	let allList: Array<{
		pid: number;
		parentPid: number;
		name: string;
		cpu: number;
		mem: number;
		memRss: number;
		command: string;
	}> = [];

	try {
		const result = await si.processes();
		// systeminformation returns { all, list:[...] }
		allList = (result.list as typeof allList) ?? [];
	} catch (e) {
		debug.warn('project', 'si.processes failed:', e);
		return {
			status: 'running',
			cpuPercent: 0,
			memRssBytes: 0,
			memPercent: 0,
			processCount: rootPids.length,
			processes: [],
			rootPids
		};
	}

	// Build project pid set via BFS through parentPid chain
	const pidSet = new Set<number>(rootPids);
	let added = true;
	// Prevent infinite loop: at most one full pass per new pid, limited rounds
	let rounds = 0;
	while (added && rounds < 10) {
		added = false;
		rounds++;
		for (const proc of allList) {
			if (!pidSet.has(proc.pid) && pidSet.has(proc.parentPid)) {
				pidSet.add(proc.pid);
				added = true;
			}
		}
	}

	const matched = allList.filter((p) => pidSet.has(p.pid));

	let cpuPercent = 0;
	let memPercent = 0;
	let memRssKb = 0;
	for (const p of matched) {
		cpuPercent += typeof p.cpu === 'number' ? p.cpu : 0;
		memPercent += typeof p.mem === 'number' ? p.mem : 0;
		memRssKb += typeof p.memRss === 'number' ? p.memRss : 0;
	}

	// memRss from si is in KB, convert to bytes
	const memRssBytes = memRssKb * 1024;

	// If none of the root pids were found in the OS process list (e.g. just spawned
	// and not yet visible), still report running with the count of sessions.
	if (matched.length === 0) {
		return {
			status: 'running',
			cpuPercent: 0,
			memRssBytes: 0,
			memPercent: 0,
			processCount: 0,
			processes: [],
			rootPids
		};
	}

	return {
		status: 'running',
		cpuPercent,
		memRssBytes,
		memPercent,
		processCount: matched.length,
		processes: matched
			.slice()
			.sort((a, b) => b.cpu - a.cpu)
			.slice(0, 20)
			.map((p) => ({
				pid: p.pid,
				parentPid: p.parentPid,
				name: p.name,
				cpu: p.cpu,
				mem: p.mem,
				memRss: p.memRss,
				command: p.command
			})),
		rootPids
	};
}

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
				cpuPercent: t.Number(),
				memRssBytes: t.Number(),
				memPercent: t.Number(),
				processCount: t.Number(),
				rootPids: t.Array(t.Number()),
				processes: t.Array(
					t.Object({
						pid: t.Number(),
						parentPid: t.Number(),
						name: t.String(),
						cpu: t.Number(),
						mem: t.Number(),
						memRss: t.Number(),
						command: t.String()
					})
				)
			}),
			meta: t.Object({
				platform: t.String(),
				arch: t.String()
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
			getFolderStatsCached(project.path),
			getProjectProcessStats(data.id)
		]);

		return {
			project,
			storage,
			resources,
			meta: {
				platform: process.platform,
				arch: process.arch
			}
		};
	}
);
