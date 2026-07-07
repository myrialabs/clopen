import { projectState } from '$frontend/stores/core/projects.svelte';
import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

interface IgnoredPathsState {
	/** Absolute path -> true for ignored files and directories. */
	set: Set<string>;
}

export const ignoredPathsState = $state<IgnoredPathsState>({
	set: new Set()
});

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let pendingRefresh = false;
let unsubscribeFiles: (() => void) | null = null;
let unsubscribeGit: (() => void) | null = null;

async function fetchIgnoredPaths(projectId: string): Promise<void> {
	if (inFlight) {
		pendingRefresh = true;
		return;
	}
	inFlight = true;
	try {
		const result: { ignored: string[] } = await ws.http('git:ignored-paths', { projectId });
		ignoredPathsState.set = new Set(result.ignored);
	} catch (err) {
		debug.error('git', 'Failed to fetch ignored paths:', err);
	} finally {
		inFlight = false;
		if (pendingRefresh) {
			pendingRefresh = false;
			refreshIgnoredPaths(0);
		}
	}
}

export function refreshIgnoredPaths(delay = 250): void {
	const project = projectState.currentProject;
	if (!project) {
		ignoredPathsState.set = new Set();
		return;
	}
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = setTimeout(() => {
		refreshTimer = null;
		fetchIgnoredPaths(project.id);
	}, delay);
}

/**
 * Initialize the store: subscribe to change events for auto-refresh.
 * Mirrors initGitStatus() so the ignored set doesn't go stale after
 * file-system changes (e.g. `bun install` creating `node_modules`) or
 * `.gitignore` edits.
 */
export function initIgnoredPaths(): void {
	refreshIgnoredPaths(0);
	if (unsubscribeFiles || unsubscribeGit) return;
	unsubscribeFiles = ws.on('files:changed', (payload) => {
		if (payload.projectId !== projectState.currentProject?.id) return;
		refreshIgnoredPaths(500);
	});
	unsubscribeGit = ws.on('git:changed', (payload) => {
		if (payload.projectId !== projectState.currentProject?.id) return;
		refreshIgnoredPaths(150);
	});
}

export function isPathIgnored(absolutePath: string): boolean {
	return ignoredPathsState.set.has(absolutePath);
}
