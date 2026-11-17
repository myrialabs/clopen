/**
 * Git Status Store
 *
 * Tracks per-file git status for the active project so that the file tree
 * (and any other consumer) can render colored indicators. Paths in the
 * exposed map are absolute (matching FileNode.path), keyed for O(1) lookups.
 */

import { projectState } from '$frontend/stores/core/projects.svelte';
import { currentScopeKey } from '$frontend/stores/features/worktrees.svelte';
import ws, { onWsReconnect } from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import { buildGitStatusMaps } from '$frontend/utils/git-status';

interface GitStatusState {
	/** Absolute path -> single-letter status code (M/A/D/R/?/U/T/C). */
	map: Map<string, string>;
	/** Absolute folder path -> highest-priority descendant status code. */
	folderMap: Map<string, string>;
	/**
	 * Absolute paths that still differ in the WORKING TREE — unstaged edits and
	 * untracked files.
	 *
	 * `map` cannot answer this: it falls back to the index status when the
	 * working status is clean, so a fully staged file looks identical to an
	 * unstaged one. Anything that needs to know whether a change is still
	 * waiting to be reviewed — the AI-change dot, for one — has to ask here.
	 */
	unstagedSet: Set<string>;
	isRepo: boolean;
}

export const gitStatusState = $state<GitStatusState>({
	map: new Map(),
	folderMap: new Map(),
	unstagedSet: new Set(),
	isRepo: false
});

/**
 * Bumped by every event that can change `git status` (a working-tree change, a
 * git state change, a watcher resync, a reconnect). Two reads made under the
 * same generation are the same read, so they share one request.
 */
let changeGeneration = 0;
let sharedRead: { projectId: string; generation: number; startedAt: number; promise: Promise<GitStatusResponse> } | null = null;

/**
 * A read is only shared while it is fresh. Readers reacting to the same event
 * ask within a few hundred ms of each other; without an age limit, a read from
 * before a long stretch with no listener counting changes (both panels closed)
 * would be handed to the next panel that opened.
 */
const SHARE_WINDOW_MS = 2000;

type GitStatusResponse = Awaited<ReturnType<typeof readGitStatus>>;

function readGitStatus(projectId: string) {
	return ws.http('git:status', { projectId });
}

/**
 * `git status` for a project — the one way the app reads it.
 *
 * The file tree's badges (this store) and the Git panel both refresh on the
 * same change events, and used to issue a request each: two `git status`
 * processes and two payloads for every edit. A read is shared while no change
 * event has arrived since it started. Pass `force` after an action of your own
 * (stage, commit, discard…), whose change event may not have arrived yet.
 */
export function loadGitStatus(projectId: string, options: { force?: boolean } = {}): Promise<GitStatusResponse> {
	if (
		!options.force &&
		sharedRead &&
		sharedRead.projectId === projectId &&
		sharedRead.generation === changeGeneration &&
		Date.now() - sharedRead.startedAt < SHARE_WINDOW_MS
	) {
		return sharedRead.promise;
	}
	const promise = readGitStatus(projectId);
	const read = { projectId, generation: changeGeneration, startedAt: Date.now(), promise };
	sharedRead = read;
	promise.catch(() => {
		if (sharedRead === read) sharedRead = null;
	});
	return promise;
}

/** Note that something may have changed `git status`; the next read is fresh. */
export function noteGitStatusChange(): void {
	changeGeneration++;
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let pendingRefresh = false;
let unsubscribeFiles: (() => void) | null = null;
let unsubscribeGit: (() => void) | null = null;
let unsubscribeResync: (() => void) | null = null;
let unsubscribeReconnect: (() => void) | null = null;
let lastProjectId = '';

async function fetchStatus(projectId: string, projectPath: string): Promise<void> {
	if (inFlight) {
		pendingRefresh = true;
		return;
	}
	inFlight = true;
	try {
		const status = await loadGitStatus(projectId);
		gitStatusState.isRepo = status.isRepo;
		if (!status.isRepo) {
			gitStatusState.map = new Map();
			gitStatusState.folderMap = new Map();
			gitStatusState.unstagedSet = new Set();
			return;
		}
		const built = buildGitStatusMaps(status, projectPath);
		gitStatusState.map = built.map;
		gitStatusState.folderMap = built.folderMap;
		gitStatusState.unstagedSet = built.unstagedSet;
	} catch (err) {
		debug.error('git', 'Failed to fetch git status:', err);
	} finally {
		inFlight = false;
		if (pendingRefresh) {
			pendingRefresh = false;
			refreshGitStatus(0);
		}
	}
}

/**
 * Schedule a debounced refresh of git status for the current project.
 */
export function refreshGitStatus(delay = 250): void {
	const project = projectState.currentProject;
	if (!project) {
		gitStatusState.map = new Map();
		gitStatusState.folderMap = new Map();
		gitStatusState.unstagedSet = new Set();
		gitStatusState.isRepo = false;
		return;
	}
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		fetchStatus(project.id, project.path);
	}, delay);
}

/**
 * Initialize the store: subscribe to change events for auto-refresh.
 * Should be called once after the WS connection is ready.
 *
 * Listens to BOTH `files:changed` (working-tree edits) and `git:changed`
 * (index/HEAD/refs mutations such as commit, stage, branch switch). A bare
 * `git commit` touches only `.git/`, which the working-tree watcher ignores —
 * so without the `git:changed` subscription the M/A/D badges would go stale
 * until some unrelated file write happened to trigger a refresh.
 */
export function initGitStatus(): void {
	if (unsubscribeFiles || unsubscribeGit) return;
	unsubscribeFiles = ws.on('files:changed', (payload) => {
		if (payload.projectId !== currentScopeKey()) return;
		// An empty change list says nothing changed — refreshing on it would spawn
		// a git process for no reason.
		if (payload.changes.length === 0) return;
		changeGeneration++;
		refreshGitStatus(500);
	});
	unsubscribeGit = ws.on('git:changed', (payload) => {
		if (payload.projectId !== currentScopeKey()) return;
		changeGeneration++;
		refreshGitStatus(150);
	});
	unsubscribeResync = ws.on('files:resync', (payload) => {
		if (payload.projectId !== currentScopeKey()) return;
		changeGeneration++;
		refreshGitStatus(500);
	});
	// Every `git:changed` sent while the socket was down was delivered to nobody,
	// so the badges have no way of knowing what they missed. Re-read once the
	// connection is back rather than waiting for the next unrelated file write.
	unsubscribeReconnect = onWsReconnect(() => {
		changeGeneration++;
		refreshGitStatus(250);
	});
}

/**
 * Reset state when the active project changes. Call from app/project store
 * once the new project is in `projectState.currentProject`.
 */
export function syncGitStatusForProject(): void {
	const project = projectState.currentProject;
	const newId = project?.id || '';
	if (newId === lastProjectId) return;
	lastProjectId = newId;
	gitStatusState.map = new Map();
	gitStatusState.folderMap = new Map();
	gitStatusState.unstagedSet = new Set();
	gitStatusState.isRepo = false;
	if (project) {
		refreshGitStatus(0);
	}
}
