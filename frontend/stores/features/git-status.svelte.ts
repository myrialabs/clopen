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
import type { GitFileChange, GitStatus } from '$shared/types/git';

interface GitStatusState {
	/** Absolute path -> single-letter status code (M/A/D/R/?/U/T/C). */
	map: Map<string, string>;
	/** Absolute folder path -> highest-priority descendant status code. */
	folderMap: Map<string, string>;
	isRepo: boolean;
}

export const gitStatusState = $state<GitStatusState>({
	map: new Map(),
	folderMap: new Map(),
	isRepo: false
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let pendingRefresh = false;
// Generation token (GIT-RACE-01, same pattern as SES-01): every scheduled
// refresh bumps it; a response that resolves after a project switch (or a
// newer refresh) is discarded instead of overwriting the new project's maps.
let statusLoadToken = 0;
let unsubscribeFiles: (() => void) | null = null;
let unsubscribeGit: (() => void) | null = null;
let unsubscribeResync: (() => void) | null = null;
let unsubscribeReconnect: (() => void) | null = null;
let lastProjectId = '';
// GIT-RACE-01: project id alone cannot distinguish worktrees of the same
// project — the scope key (projectId + active worktree) is the identity the
// listeners already filter by. Track it so a worktree switch resets too.
let lastScopeKey = '';

/**
 * Pick the most meaningful single status code for a change entry.
 * Prefers working-tree status, falls back to index status. Untracked is `?`.
 */
function pickStatusCode(change: GitFileChange): string {
	const w = (change.workingStatus || '').trim();
	const i = (change.indexStatus || '').trim();
	if (w && w !== ' ') return w;
	if (i && i !== ' ') return i;
	return '';
}

function buildStatusMaps(
	status: GitStatus,
	projectPath: string
): { map: Map<string, string>; folderMap: Map<string, string> } {
	const map = new Map<string, string>();
	const folderMap = new Map<string, string>();
	const sep = projectPath.includes('\\') ? '\\' : '/';

	const upsertFolder = (folderPath: string, code: string) => {
		const existing = folderMap.get(folderPath);
		const newRank = FOLDER_STATUS_PRIORITY[code] ?? 0;
		const oldRank = existing ? (FOLDER_STATUS_PRIORITY[existing] ?? 0) : -1;
		if (newRank > oldRank) folderMap.set(folderPath, code);
	};

	const collect = (entries: GitFileChange[]) => {
		for (const change of entries) {
			const code = pickStatusCode(change);
			if (!code) continue;
			const rel = sep === '\\' ? change.path.replace(/\//g, '\\') : change.path;
			const absolute = `${projectPath}${sep}${rel}`;
			map.set(absolute, code);

			// Walk all ancestors up to (excluding) project root and aggregate
			let cursor = absolute;
			while (true) {
				const idx = cursor.lastIndexOf(sep);
				if (idx <= 0) break;
				cursor = cursor.slice(0, idx);
				if (cursor === projectPath || cursor.length < projectPath.length) break;
				upsertFolder(cursor, code);
			}
		}
	};

	collect(status.conflicted);
	collect(status.staged);
	collect(status.unstaged);
	collect(status.untracked);

	return { map, folderMap };
}

async function fetchStatus(projectId: string, projectPath: string, scopeKey: string): Promise<void> {
	if (inFlight) {
		pendingRefresh = true;
		return;
	}
	inFlight = true;
	const token = ++statusLoadToken;
	try {
		const status = await ws.http('git:status', { projectId });
		// Stale: a switch or newer refresh started while this was in flight,
		// or the active scope moved (project or worktree) — never let an old
		// response overwrite the active project/worktree maps.
		if (token !== statusLoadToken) return;
		if (scopeKey !== currentScopeKey()) return;
		gitStatusState.isRepo = status.isRepo;
		if (!status.isRepo) {
			gitStatusState.map = new Map();
			gitStatusState.folderMap = new Map();
			return;
		}
		const built = buildStatusMaps(status, projectPath);
		gitStatusState.map = built.map;
		gitStatusState.folderMap = built.folderMap;
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
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
		statusLoadToken++;
		gitStatusState.map = new Map();
		gitStatusState.folderMap = new Map();
		gitStatusState.isRepo = false;
		return;
	}
	// Snapshot identity NOW: the timer may fire after a project/worktree
	// switch, and fetchStatus re-validates both before applying.
	const scopeKey = currentScopeKey();
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		fetchStatus(project.id, project.path, scopeKey);
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
	const newScope = currentScopeKey();
	if (newId === lastProjectId && newScope === lastScopeKey) return;
	lastProjectId = newId;
	lastScopeKey = newScope;
	// Drop any pending debounce from the previous project/scope: it carries
	// old identity refs and must never fire after the switch and steal the
	// newest generation token.
	if (refreshTimer) {
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}
	pendingRefresh = false;
	// Invalidate any in-flight fetch for the previous project/scope so its
	// late response cannot overwrite the new scope's (cleared) maps.
	statusLoadToken++;
	gitStatusState.map = new Map();
	gitStatusState.folderMap = new Map();
	gitStatusState.isRepo = false;
	if (project) {
		refreshGitStatus(0);
	}
}

/**
 * Aggregation priority — the highest-priority status visible determines
 * a folder's color. Conflicts and untracked files surface above plain mods.
 */
const FOLDER_STATUS_PRIORITY: Record<string, number> = {
	U: 100,
	'?': 80,
	M: 70,
	D: 60,
	A: 50,
	R: 40,
	C: 30,
	T: 20
};
