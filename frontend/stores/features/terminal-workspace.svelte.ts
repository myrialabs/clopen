/**
 * Terminal Dock Workspace State
 *
 * Per-project terminal tab-list (which tabs exist + which is active), persisted
 * server-side through the project workspace coordinator (a `terminal` dock).
 *
 * The PTY processes and their scrollback live on the backend and survive a
 * refresh on their own; what was missing was a single source of truth for the
 * TAB-LIST. Previously the tabs were rebuilt by racing a backend PTY query right
 * after the room switched, so the first switch (or a refresh) often produced a
 * lone empty tab and only a second project-click restored the real tabs.
 *
 * Now the tab-list is snapshot into the per-project blob (DB) and restored
 * deterministically inside the coordinator's barrier: the dock's `load()` drives
 * the terminal manager's project switch, which seeds the restored tab-list as
 * authoritative before any backend query — no race, all docks reveal together.
 */

import {
	registerDock,
	requestWorkspaceSave,
	getActiveWorkspaceProjectId
} from '$frontend/stores/ui/project-workspace.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';
import { debug } from '$shared/utils/logger';

export interface TerminalSlice {
	sessionIds: string[];
	activeSessionId: string | null;
}

// Slices the coordinator restored from the blob, awaiting the terminal manager
// to consult them when it (re)builds a project's tabs. The manager keeps its own
// in-memory contexts for instant A→B→A switches, so this is only the cold-start
// (post-refresh) source of truth.
const restoredSlices = new Map<string, TerminalSlice>();

// The manager registers a provider so the coordinator can snapshot the LIVE
// tab-list of the active project (the manager owns the authoritative state).
let snapshotProvider: ((projectId: string) => TerminalSlice | undefined) | null = null;

export function setTerminalSnapshotProvider(
	fn: ((projectId: string) => TerminalSlice | undefined) | null
): void {
	snapshotProvider = fn;
}

/** The tab-list restored from the blob for a project (null when none). */
export function getRestoredTerminalSlice(projectId: string): TerminalSlice | undefined {
	return restoredSlices.get(projectId);
}

/** Queue a debounced server save of the active project's terminal tab-list. */
export function markTerminalDirty(): void {
	requestWorkspaceSave();
}

registerDock({
	id: 'terminal',
	snapshot() {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return undefined;
		const slice = snapshotProvider ? snapshotProvider(projectId) : restoredSlices.get(projectId);
		if (!slice || slice.sessionIds.length === 0) return undefined;
		return slice;
	},
	restore(slice) {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;
		if (
			slice &&
			typeof slice === 'object' &&
			Array.isArray((slice as TerminalSlice).sessionIds)
		) {
			const s = slice as TerminalSlice;
			restoredSlices.set(projectId, {
				sessionIds: [...s.sessionIds],
				activeSessionId: s.activeSessionId ?? s.sessionIds[0] ?? null
			});
		} else {
			restoredSlices.delete(projectId);
		}
	},
	async load(projectId) {
		const project = projectState.projects.find((p) => p.id === projectId);
		if (!project) return;
		try {
			// Dynamic import to avoid a static cycle (the manager imports this module).
			const { terminalProjectManager } = await import('$frontend/services/terminal');
			await terminalProjectManager.switchToProject(projectId, project.path);
		} catch (err) {
			debug.error('terminal', 'Failed to restore terminal tabs for project:', projectId, err);
		}
	}
	// No clear(): switchToProject() saves+hides the outgoing project's tabs itself,
	// and the switch barrier hides any in-between frame, so a separate clear would
	// only risk discarding the outgoing project's state before it is saved.
});

registerProjectCleanup((projectId) => {
	restoredSlices.delete(projectId);
});
