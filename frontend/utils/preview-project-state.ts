import type { DeviceSize, Rotation } from '$frontend/utils/preview-constants';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';
import {
	registerDock,
	requestWorkspaceSave,
	getActiveWorkspaceProjectId
} from '$frontend/stores/ui/project-workspace.svelte';

export interface ProjectPreviewState {
	isOpen: boolean;
	url: string;
	mode: 'split' | 'tab';
	deviceSize: DeviceSize;
	rotation: Rotation;
}

const projectPreviewState = new Map<string, ProjectPreviewState>();

export function getProjectPreviewState(projectId: string): ProjectPreviewState | undefined {
	return projectPreviewState.get(projectId);
}

export function setProjectPreviewState(projectId: string, state: ProjectPreviewState): void {
	projectPreviewState.set(projectId, state);
	// Persist this project's preview prefs server-side (debounced) so they
	// survive a full refresh and follow the user across devices.
	requestWorkspaceSave();
}

export function clearProjectPreviewState(projectId: string): void {
	projectPreviewState.delete(projectId);
}

// PreviewPanel registers a provider so the coordinator can snapshot the LIVE
// preview prefs of the active project (the in-memory map only updates on switch).
let snapshotProvider: (() => ProjectPreviewState) | null = null;

export function setPreviewSnapshotProvider(fn: (() => ProjectPreviewState) | null): void {
	snapshotProvider = fn;
}

registerDock({
	id: 'preview',
	snapshot() {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return undefined;
		// Prefer live prefs from the active panel; fall back to the cached map.
		return snapshotProvider ? snapshotProvider() : projectPreviewState.get(projectId);
	},
	restore(slice) {
		const projectId = getActiveWorkspaceProjectId();
		if (!projectId) return;
		if (slice && typeof slice === 'object') {
			// Seed the map so PreviewPanel's project-change effect restores it.
			projectPreviewState.set(projectId, slice as ProjectPreviewState);
		}
	}
	// No clear(): PreviewPanel manages its own switch; the skeleton overlay hides
	// any in-between frame, and recovery is driven by the panel's own effect.
});

registerProjectCleanup((projectId) => {
	clearProjectPreviewState(projectId);
});
