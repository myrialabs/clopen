/**
 * The storage report: one pass over everything Clopen keeps on disk.
 *
 * Runs in the background and is single-flighted; the last report is kept (in
 * memory and in settings) so the panel opens on real numbers immediately and
 * refreshes behind them. Nothing here blocks the event loop for long: the file
 * walks are asynchronous, the message table is read a chat at a time through
 * the session index, and every phase yields.
 *
 * Every category is measured as a folder first and then broken down, so the
 * categories always add up to the total even where attribution is partial.
 */

import fs from 'node:fs/promises';
import { projectQueries } from '$backend/database/queries';
import { settingsQueries } from '$backend/database/queries/settings-queries';
import { getClopenDir, getEngineUserConfigDir } from '$backend/utils/paths';
import type {
	CleanupActionId, CleanupEstimate, StorageCategory, StorageCategoryId, StorageEngineEntry,
	StorageProjectEntry, StorageReport, StorageScanStatus
} from '$shared/types/storage';
import type { EngineType } from '$shared/types/unified';
import { debug } from '$shared/utils/logger';
import { databasePath, databaseStats, freeDiskBytes } from './database';
import { ENGINE_HOME_NAMES, legacyEnginePaths, measurePaths, staleLogFiles, toolCachePaths } from './engine-homes';
import { measureChildren, measurePath } from './fs-size';
import { listProfileDirs, orphanProfiles } from './preview-profiles';
import { activeChatIds, activeEngineSessionIds } from './purge';
import { collectEngineRefs, ensureFreshSessionIndex, readSessionIndex, refreshSessionIndex } from './session-index';
import { blobOwners, blobSizes, orphanBlobs } from './snapshots';
import { listAllTranscripts, selectOrphans, selectRedundant, type TranscriptEntry, type TranscriptUsage } from './transcripts';
import { openCodeDatabases } from './transcripts/opencode';
import { listWorktreeDirs, orphanWorktreeDirs } from './worktrees';

const REPORT_SETTING = 'storage_last_report';

/** Engine home folder name → engine type. */
const ENGINE_OF_HOME: Record<(typeof ENGINE_HOME_NAMES)[number], EngineType> = {
	claude: 'claude-code',
	codex: 'codex',
	copilot: 'copilot',
	qwen: 'qwen',
	opencode: 'opencode',
	pi: 'pi',
	cursor: 'cursor'
};

let lastReport: StorageReport | null = null;
let scanInFlight: Promise<StorageReport> | null = null;
let controller: AbortController | null = null;
const status: StorageScanStatus = { scanning: false, phase: null, progress: null, startedAt: null, error: null };
const listeners = new Set<(status: StorageScanStatus, report: StorageReport | null) => void>();

export function onStorageScan(listener: (status: StorageScanStatus, report: StorageReport | null) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function publish(report: StorageReport | null = null): void {
	for (const listener of listeners) {
		try {
			listener({ ...status }, report);
		} catch { /* a listener's failure is its own */ }
	}
}

let lastPhaseAt = 0;
function setPhase(phase: string | null, progress: number | null = null): void {
	status.phase = phase;
	status.progress = progress;
	// Progress ticks are throttled; phase changes always go out.
	const now = Date.now();
	if (progress === null || now - lastPhaseAt > 500) {
		lastPhaseAt = now;
		publish();
	}
}

export function getStorageScanStatus(): StorageScanStatus {
	return { ...status };
}

export function getLastStorageReport(): StorageReport | null {
	if (lastReport) return lastReport;
	const raw = settingsQueries.get(REPORT_SETTING)?.value;
	if (!raw) return null;
	try {
		lastReport = JSON.parse(raw) as StorageReport;
	} catch {
		lastReport = null;
	}
	return lastReport;
}

/** Start a scan, or join the one running. */
export function scanStorage(): Promise<StorageReport> {
	if (scanInFlight) return scanInFlight;
	controller = new AbortController();
	status.scanning = true;
	status.startedAt = new Date().toISOString();
	status.error = null;
	publish();

	scanInFlight = buildReport(controller.signal)
		.then(report => {
			lastReport = report;
			try {
				settingsQueries.set(REPORT_SETTING, JSON.stringify(report));
			} catch (error) {
				debug.warn('storage', 'Could not persist the storage report:', error);
			}
			return report;
		})
		.catch(error => {
			status.error = error instanceof Error ? error.message : String(error);
			throw error;
		})
		.finally(() => {
			status.scanning = false;
			status.phase = null;
			status.progress = null;
			scanInFlight = null;
			controller = null;
			publish(lastReport);
		});
	return scanInFlight;
}

export function cancelStorageScan(): void {
	controller?.abort();
}

/**
 * What every engine session id in use is, right now. Refreshes the session index
 * first. `strict` — for anything that deletes — also proves the index complete
 * and throws when it is not; a scan only prices, so it takes what it has.
 */
export async function currentTranscriptUsage(
	options: { strict?: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}
): Promise<TranscriptUsage> {
	if (options.strict) await ensureFreshSessionIndex(activeChatIds());
	else await refreshSessionIndex({ signal: options.signal, onProgress: options.onProgress });
	const { byEngine, owners } = collectEngineRefs();
	return { refs: byEngine, owners, active: activeEngineSessionIds() };
}

function sumBytes(entries: { bytes: number }[]): number {
	return entries.reduce((total, entry) => total + entry.bytes, 0);
}

function transcriptBytes(entry: TranscriptEntry): number {
	return entry.bytes + (entry.sidecar?.bytes ?? 0);
}

async function buildReport(signal: AbortSignal): Promise<StorageReport> {
	const started = Date.now();
	const dataDir = getClopenDir();

	setPhase('Measuring folders');
	const top = await measureChildren(dataDir, signal);
	const sizeOf = (name: string) => top.get(name)?.bytes ?? 0;
	const totalBytes = [...top.values()].reduce((total, size) => total + size.bytes, 0);

	setPhase('Indexing chats', 0);
	const usage = await currentTranscriptUsage({ signal, onProgress: (done, total) => setPhase('Indexing chats', done / total) });
	const index = readSessionIndex();

	setPhase('Reading engine transcripts');
	const transcripts = await listAllTranscripts(signal);
	const orphans = selectOrphans(transcripts, usage);
	setPhase('Finding duplicate transcripts');
	const redundant = await selectRedundant(transcripts, usage, { signal });

	setPhase('Reading checkpoints');
	const blobs = await blobSizes(signal);
	const owners = await blobOwners();
	const orphanedBlobs = orphanBlobs(blobs);

	setPhase('Reading worktrees and previews');
	const worktreeDirs = await listWorktreeDirs(signal);
	const leftoverWorktrees = orphanWorktreeDirs(worktreeDirs);
	const profiles = await listProfileDirs(signal);
	const leftoverProfiles = orphanProfiles(profiles);

	setPhase('Reading engine folders');
	const toolCaches = await toolCachePaths();
	const toolCacheBytes = await measurePaths(toolCaches);
	const legacy = await legacyEnginePaths();
	const legacyBytes = await measurePaths(legacy);
	const logs = await staleLogFiles();
	const logBytes = sumBytes(logs);
	const openCodeDbBytes = await (async () => {
		let bytes = 0;
		for (const { file } of await openCodeDatabases()) {
			for (const suffix of ['', '-wal', '-shm']) bytes += (await measurePath(file + suffix)).bytes;
		}
		return bytes;
	})();

	const database = databaseStats();
	const free = await freeDiskBytes(databasePath());
	const diskTotal = await (async () => {
		try {
			const stats = await fs.statfs(dataDir);
			return Number(stats.blocks) * Number(stats.bsize);
		} catch {
			return null;
		}
	})();

	// ── Engines ──────────────────────────────────────────────────────────────
	const orphanIds = new Set(orphans.map(entry => `${entry.engine}\u0000${entry.id}`));
	const engines: StorageEngineEntry[] = [];
	let allTranscriptBytes = 0;
	for (const home of ENGINE_HOME_NAMES) {
		const engine = ENGINE_OF_HOME[home];
		const homeBytes = (await measurePath(getEngineUserConfigDir(home), signal)).bytes;
		const own = transcripts.filter(entry => entry.engine === engine);
		const ownOrphans = own.filter(entry => orphanIds.has(`${entry.engine}\u0000${entry.id}`));
		const ownRedundant = redundant.filter(item => item.entry.engine === engine);
		const ownBytes = sumBytes(own.map(entry => ({ bytes: transcriptBytes(entry) }))) + (engine === 'opencode' ? openCodeDbBytes : 0);
		allTranscriptBytes += ownBytes;
		if (homeBytes === 0 && own.length === 0) continue;
		engines.push({
			engine,
			transcriptBytes: ownBytes,
			transcriptCount: own.filter(entry => !entry.sidecarOnly).length,
			orphanBytes: sumBytes(ownOrphans.map(entry => ({ bytes: transcriptBytes(entry) }))),
			orphanCount: ownOrphans.length,
			redundantBytes: sumBytes(ownRedundant.map(item => item.entry)),
			redundantCount: ownRedundant.length,
			otherBytes: Math.max(0, homeBytes - ownBytes)
		});
	}

	// ── Estimates for the parameterless actions ─────────────────────────────
	const browserCacheBytes = profiles.filter(dir => dir.scope && !dir.running).reduce((total, dir) => total + dir.cacheBytes, 0);
	const estimates: CleanupEstimate[] = [
		{ action: 'orphan-transcripts', bytes: sumBytes(orphans.map(entry => ({ bytes: transcriptBytes(entry) }))), items: orphans.length },
		{ action: 'dedupe-transcripts', bytes: sumBytes(redundant.map(item => item.entry)), items: redundant.length },
		{ action: 'orphan-snapshots', bytes: orphanedBlobs.bytes, items: orphanedBlobs.hashes.length },
		{ action: 'orphan-profiles', bytes: sumBytes(leftoverProfiles), items: leftoverProfiles.length },
		{ action: 'orphan-worktree-dirs', bytes: sumBytes(leftoverWorktrees), items: leftoverWorktrees.length },
		{ action: 'legacy-engine-data', bytes: legacyBytes, items: legacy.length },
		{ action: 'browser-cache', bytes: browserCacheBytes, items: profiles.filter(dir => dir.scope && dir.cacheBytes > 0).length },
		{ action: 'tool-caches', bytes: toolCacheBytes, items: toolCaches.length },
		{ action: 'engine-logs', bytes: logBytes, items: logs.length },
		{ action: 'compact-database', bytes: database.freeBytes, items: database.freeBytes > 0 ? 1 : 0 }
	];
	const estimateOf = (action: CleanupActionId) => estimates.find(e => e.action === action)?.bytes ?? 0;

	// ── Categories ───────────────────────────────────────────────────────────
	const chatsBytes = database.fileBytes;
	const engineCacheBytes = Math.max(0, sizeOf('engine') - allTranscriptBytes);
	const known: Record<Exclude<StorageCategoryId, 'other'>, [number, number]> = {
		chats: [chatsBytes, estimateOf('compact-database')],
		'engine-transcripts': [allTranscriptBytes, estimateOf('orphan-transcripts') + estimateOf('dedupe-transcripts')],
		'engine-caches': [engineCacheBytes, estimateOf('legacy-engine-data') + estimateOf('engine-logs')],
		snapshots: [sizeOf('snapshots'), estimateOf('orphan-snapshots')],
		worktrees: [sizeOf('worktrees'), estimateOf('orphan-worktree-dirs')],
		'preview-profiles': [sizeOf('preview'), estimateOf('orphan-profiles') + browserCacheBytes],
		stack: [sizeOf('stack'), 0]
	};
	const knownTotal = Object.values(known).reduce((total, [bytes]) => total + bytes, 0);
	const categories: StorageCategory[] = [
		...Object.entries(known).map(([id, [bytes, reclaimableBytes]]) => ({ id: id as StorageCategoryId, bytes, reclaimableBytes })),
		{ id: 'other', bytes: Math.max(0, totalBytes - knownTotal), reclaimableBytes: 0 }
	];

	// ── Projects ─────────────────────────────────────────────────────────────
	const chatProject = new Map(index.map(row => [row.sessionId, row.projectId]));
	const projects = new Map<string, StorageProjectEntry>();
	for (const project of projectQueries.getAll()) {
		projects.set(project.id, {
			projectId: project.id,
			name: project.name,
			path: project.path,
			bytes: 0,
			breakdown: { chats: 0, engineTranscripts: 0, snapshots: 0, worktrees: 0, previewProfiles: 0 },
			sessionCount: 0,
			slimmedSessionCount: 0,
			worktreeCount: 0,
			lastActivityAt: null
		});
	}
	for (const row of index) {
		const entry = projects.get(row.projectId);
		if (!entry) continue;
		entry.breakdown.chats += row.bytes;
		entry.sessionCount++;
		if (row.slimmedAt) entry.slimmedSessionCount++;
		const activity = row.lastMessageAt ?? row.startedAt;
		if (!entry.lastActivityAt || activity > entry.lastActivityAt) entry.lastActivityAt = activity;
	}
	for (const transcript of transcripts) {
		const chats = usage.owners.get(transcript.id);
		const chat = chats ? [...chats][0] : null;
		const projectId = chat ? chatProject.get(chat) : null;
		const entry = projectId ? projects.get(projectId) : null;
		if (entry) entry.breakdown.engineTranscripts += transcriptBytes(transcript);
	}
	for (const [hash, size] of blobs) {
		const projectIds = owners.get(hash);
		if (projectIds?.size !== 1) continue;
		const entry = projects.get([...projectIds][0]);
		if (entry) entry.breakdown.snapshots += size;
	}
	for (const dir of worktreeDirs) {
		const entry = dir.projectId ? projects.get(dir.projectId) : null;
		if (!entry) continue;
		entry.breakdown.worktrees += dir.bytes;
		entry.worktreeCount++;
	}
	for (const dir of profiles) {
		const entry = dir.scope ? projects.get(dir.scope.projectId) : null;
		if (entry) entry.breakdown.previewProfiles += dir.bytes;
	}
	let attributed = 0;
	for (const entry of projects.values()) {
		const b = entry.breakdown;
		entry.bytes = b.chats + b.engineTranscripts + b.snapshots + b.worktrees + b.previewProfiles;
		attributed += entry.bytes;
	}

	debug.log('storage', `Storage scan finished in ${Date.now() - started} ms (${activeChatIds().size} chat(s) streaming)`);
	return {
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - started,
		dataDir,
		totalBytes,
		disk: diskTotal !== null && free !== null ? { totalBytes: diskTotal, freeBytes: free } : null,
		categories,
		projects: [...projects.values()].sort((a, b) => b.bytes - a.bytes),
		unattributedBytes: Math.max(0, totalBytes - attributed),
		engines: engines.sort((a, b) => (b.transcriptBytes + b.otherBytes) - (a.transcriptBytes + a.otherBytes)),
		estimates,
		database
	};
}
