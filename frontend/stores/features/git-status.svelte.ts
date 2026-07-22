/**
 * Git Status Store
 *
 * Tracks per-file git status for the active project so that the file tree
 * (and any other consumer) can render colored indicators. Paths in the
 * exposed map are absolute (matching FileNode.path), keyed for O(1) lookups.
 */

import { projectState } from '$frontend/stores/core/projects.svelte';
import ws from '$frontend/utils/ws';
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
let unsubscribeFiles: (() => void) | null = null;
let unsubscribeGit: (() => void) | null = null;
let lastProjectId = '';

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
		gitStatusState.map = new Map();
		gitStatusState.folderMap = new Map();
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
		if (payload.projectId !== projectState.currentProject?.id) return;
		refreshGitStatus(500);
	});
	unsubscribeGit = ws.on('git:changed', (payload) => {
		if (payload.projectId !== projectState.currentProject?.id) return;
		refreshGitStatus(150);
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
