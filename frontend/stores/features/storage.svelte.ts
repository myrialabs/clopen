/**
 * Settings → Storage state.
 *
 * The report is the server's; this store only holds the last copy, follows the
 * scan's progress events, and runs actions. A cleanup triggers a rescan on the
 * server, whose finished report arrives on the same event as any other scan.
 */

import ws from '$frontend/utils/ws';
import type {
	CleanupActionId, CleanupActionMeta, CleanupEstimate, CleanupRequest, CleanupResult,
	StorageCleanupRun, StoragePolicy, StorageReport, StorageScanStatus
} from '$shared/types/storage';

interface StorageSnapshot {
	report: StorageReport | null;
	status: StorageScanStatus;
	policy: StoragePolicy;
	actions: CleanupActionMeta[];
	history: StorageCleanupRun[];
	running: CleanupActionId | null;
}

/** Folder sizes of project directories, from `projects:overview`. */
export interface ProjectFolderSize {
	state: 'ready' | 'measuring' | 'unavailable';
	sizeBytes: number;
	truncated: boolean;
}

const CLEANUP_TIMEOUT_MS = 30 * 60_000;

export const storageStore = $state({
	loaded: false,
	report: null as StorageReport | null,
	status: { scanning: false, phase: null, progress: null, startedAt: null, error: null } as StorageScanStatus,
	policy: null as StoragePolicy | null,
	actions: [] as CleanupActionMeta[],
	history: [] as StorageCleanupRun[],
	running: null as CleanupActionId | null,
	folders: {} as Record<string, ProjectFolderSize>,
	/**
	 * Actions already run against the current report, keyed by action (and
	 * project), valued by that report's `generatedAt`. The report's estimate for
	 * them is spent: their button stays off until a NEW report says there is
	 * something again, instead of re-enabling on stale numbers while the rescan
	 * that follows every cleanup is still running.
	 */
	spent: {} as Record<string, string>,
	error: null as string | null
});

function spentKey(request: CleanupRequest): string {
	return `${request.action}|${request.projectId ?? ''}`;
}

/** Whether an action ran since the report its numbers come from was made. */
export function isSpent(request: CleanupRequest): boolean {
	const at = storageStore.spent[spentKey(request)];
	return !!at && at === storageStore.report?.generatedAt;
}

function apply(snapshot: StorageSnapshot): void {
	storageStore.report = snapshot.report;
	storageStore.status = snapshot.status;
	storageStore.policy = snapshot.policy;
	storageStore.actions = snapshot.actions;
	storageStore.history = snapshot.history;
	storageStore.running = snapshot.running;
	storageStore.loaded = true;
}

export async function loadStorage(): Promise<void> {
	try {
		apply(await ws.http('storage:get', {}) as StorageSnapshot);
		storageStore.error = null;
		// A report older than an hour, or none at all, is refreshed on open.
		const age = storageStore.report ? Date.now() - Date.parse(storageStore.report.generatedAt) : Infinity;
		if (!storageStore.status.scanning && age > 60 * 60_000) await rescanStorage();
	} catch (error) {
		storageStore.error = error instanceof Error ? error.message : 'Could not load storage';
	}
}

export async function loadProjectFolders(): Promise<void> {
	try {
		const overview = await ws.http('projects:overview', {}, 30_000) as {
			projects: { id: string; storage: ProjectFolderSize }[];
		};
		storageStore.folders = Object.fromEntries(overview.projects.map(project => [project.id, project.storage]));
	} catch {
		// Folder sizes are an extra column; the rest of the page does not depend on them.
	}
}

export async function rescanStorage(): Promise<void> {
	storageStore.status = await ws.http('storage:scan', {}) as StorageScanStatus;
}

export async function estimateCleanup(request: CleanupRequest): Promise<CleanupEstimate> {
	return await ws.http('storage:estimate', request, 5 * 60_000) as CleanupEstimate;
}

export async function runCleanup(request: CleanupRequest): Promise<CleanupResult> {
	storageStore.running = request.action;
	try {
		const result = await ws.http('storage:cleanup', request, CLEANUP_TIMEOUT_MS) as CleanupResult;
		if (storageStore.report) storageStore.spent[spentKey(request)] = storageStore.report.generatedAt;
		return result;
	} finally {
		storageStore.running = null;
	}
}

export async function savePolicy(policy: StoragePolicy): Promise<void> {
	storageStore.policy = await ws.http('storage:policy-save', { policy }) as StoragePolicy;
}

export async function runPolicyNow(): Promise<void> {
	await ws.http('storage:run-now', {});
}

/** Follow scan progress and cleanup results. Returns the unsubscribe. */
export function subscribeStorage(): () => void {
	const offScan = ws.on('storage:scan-status', (payload) => {
		const { status, report } = payload as { status: StorageScanStatus; report: StorageReport | null };
		storageStore.status = status;
		if (report) storageStore.report = report;
	});
	const offCleanup = ws.on('storage:cleanup-finished', (payload) => {
		const { history } = payload as { history: StorageCleanupRun[] };
		if (history) storageStore.history = history;
	});
	return () => {
		offScan();
		offCleanup();
	};
}

export function formatBytes(bytes: number): string {
	if (!bytes || bytes < 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}
