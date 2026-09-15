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
		const status = await ws.http('git:status', { projectId });
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
		refreshGitStatus(500);
	});
	unsubscribeGit = ws.on('git:changed', (payload) => {
		if (payload.projectId !== currentScopeKey()) return;
		refreshGitStatus(150);
	});
	unsubscribeResync = ws.on('files:resync', (payload) => {
		if (payload.projectId !== currentScopeKey()) return;
		refreshGitStatus(500);
	});
	// Every `git:changed` sent while the socket was down was delivered to nobody,
	// so the badges have no way of knowing what they missed. Re-read once the
	// connection is back rather than waiting for the next unrelated file write.
	unsubscribeReconnect = onWsReconnect(() => {
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
