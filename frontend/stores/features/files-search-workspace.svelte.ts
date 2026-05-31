/**
 * Files Search Dock Workspace State
 *
 * Per-project view state for the Files panel's Search tab so switching projects
 * — and a full browser refresh — preserves and restores which tab was open
 * (Explore vs Search), the query, mode, and options exactly, with the DB as the
 * single source of truth.
 *
 * Mirrors the Git dock (`git-workspace.svelte.ts`): the coordinator persists a
 * lightweight slice per project and restores it into `pending` before the panel
 * activates. The search RESULTS are intentionally NOT stored — they are re-run
 * lazily on restore so the blob stays small and results never go stale.
 *
 * FileTree remounts often (mobile/desktop switch, panel close/open), so it hands
 * the coordinator a live snapshot provider rather than pushing state eagerly.
 */

import {
	registerDock,
	requestWorkspaceSave,
	getActiveWorkspaceProjectId
} from '$frontend/stores/ui/project-workspace.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

export interface FileSearchSlice {
	searchVisible: boolean;
	searchQuery: string;
	submittedQuery: string;
	searchMode: 'files' | 'code';
	caseSensitive: boolean;
	wholeWord: boolean;
	useRegex: boolean;
	filesToInclude: string;
	filesToExclude: string;
	showFilters: boolean;
	showReplace: boolean;
	replaceQuery: string;
}

// Slices the coordinator restored (server or its in-session cache), awaiting the
// panel to read them for the active project. As with the Git dock we keep no
// second cache here — the coordinator's per-project blob cache already gives
// instant A→B→A persistence.
const pending = new Map<string, FileSearchSlice>();

let snapshotProvider: (() => FileSearchSlice | undefined) | null = null;

/** FileTree registers a provider so the coordinator can snapshot live state. */
export function setFileSearchSnapshotProvider(fn: (() => FileSearchSlice | undefined) | null): void {
	snapshotProvider = fn;
}

/**
 * Load a project's search view from the slice the coordinator restored (server
 * or its in-session cache), else null (caller falls back to defaults).
 */
export function loadFileSearchSlice(projectId: string): FileSearchSlice | null {
	return pending.get(projectId) ?? null;
}

/** Schedule a debounced server save of the active project's search view. */
export function markFileSearchDirty(): void {
	requestWorkspaceSave();
}

registerDock({
	id: 'files-search',
	snapshot() {
		return snapshotProvider ? snapshotProvider() : undefined;
	},
	restore(slice) {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;
		if (slice && typeof slice === 'object') {
			pending.set(projectId, slice as FileSearchSlice);
		} else {
			pending.delete(projectId);
		}
	}
});

registerProjectCleanup((projectId) => {
	pending.delete(projectId);
});
