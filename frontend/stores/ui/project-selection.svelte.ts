/**
 * Project Selection Store
 * Single SSOT for the sidebar PROJECTS selection mode, pins, and archive.
 *
 * - Inactive by default: no checkbox is rendered.
 * - `enterSelectionMode()` activates it (checkboxes appear).
 * - `exitSelectionMode()` clears the set and returns the sidebar to normal.
 * - `toggleProject`, `selectAll`, `clearSelection` share the same Set,
 *   so Select All / individual / Delete / Archive always agree.
 * - Archive is local-only (no backend call, sessions/data untouched) and
 *   persisted server-side via `user:save-state` like the project order.
 *   Archived projects leave the main list and live in the Archived section.
 */

import ws from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';
import type { Project } from '$shared/types/database/schema';

interface ProjectSelectionState {
	active: boolean;
	selectedIds: string[];
	pinnedIds: string[];
	archivedIds: string[];
}

export const projectSelectionState = $state<ProjectSelectionState>({
	active: false,
	selectedIds: [],
	pinnedIds: [],
	archivedIds: []
});

export function isSelectionMode(): boolean {
	return projectSelectionState.active;
}

export function enterSelectionMode(): void {
	projectSelectionState.active = true;
}

export function exitSelectionMode(): void {
	projectSelectionState.active = false;
	projectSelectionState.selectedIds = [];
}

export function isProjectSelected(projectId: string | undefined): boolean {
	if (!projectId) return false;
	return projectSelectionState.selectedIds.includes(projectId);
}

export function selectedCount(): number {
	return projectSelectionState.selectedIds.length;
}

export function toggleProjectSelection(projectId: string | undefined): void {
	if (!projectId) return;
	if (!projectSelectionState.active) projectSelectionState.active = true;
	const idx = projectSelectionState.selectedIds.indexOf(projectId);
	if (idx === -1) {
		projectSelectionState.selectedIds = [...projectSelectionState.selectedIds, projectId];
	} else {
		// Deselecting only unchecks — it never leaves Selection Mode.
		// Exiting (which also clears all picks) is exclusively via
		// exitSelectionMode(), wired to the ✕ button.
		projectSelectionState.selectedIds = projectSelectionState.selectedIds.filter(
			(id) => id !== projectId
		);
	}
}

export function selectAllProjects(ids: (string | undefined)[]): void {
	const clean = ids.filter((id): id is string => Boolean(id));
	projectSelectionState.active = true;
	projectSelectionState.selectedIds = [...new Set(clean)];
}

export function clearProjectSelection(): void {
	projectSelectionState.selectedIds = [];
}

/** Toggle Select All: select visible when partial/none, clear when all selected. */
export function toggleSelectAllProjects(ids: (string | undefined)[]): void {
	if (areAllSelected(ids)) {
		clearProjectSelection();
	} else {
		selectAllProjects(ids);
	}
}

export function areAllSelected(ids: (string | undefined)[]): boolean {
	const clean = ids.filter((id): id is string => Boolean(id));
	if (clean.length === 0) return false;
	return clean.every((id) => projectSelectionState.selectedIds.includes(id));
}

export function isProjectPinned(projectId: string | undefined): boolean {
	if (!projectId) return false;
	return projectSelectionState.pinnedIds.includes(projectId);
}

export function toggleProjectPin(projectId: string | undefined): void {
	if (!projectId) return;
	if (projectSelectionState.pinnedIds.includes(projectId)) {
		projectSelectionState.pinnedIds = projectSelectionState.pinnedIds.filter((id) => id !== projectId);
	} else {
		projectSelectionState.pinnedIds = [projectId, ...projectSelectionState.pinnedIds];
	}
}

export function isProjectArchived(projectId: string | undefined): boolean {
	if (!projectId) return false;
	return projectSelectionState.archivedIds.includes(projectId);
}

function persistArchivedIds(): void {
	ws.http('user:save-state', {
		key: 'archivedProjectIds',
		value: [...projectSelectionState.archivedIds]
	}).catch((err) => {
		debug.error('project', 'Error saving archived projects to server:', err);
	});
}

export function restoreArchivedIds(ids: unknown): void {
	projectSelectionState.archivedIds = Array.isArray(ids)
		? ids.filter((id): id is string => typeof id === 'string')
		: [];
}

/** Move projects to the Archived section (local only, sessions/data untouched). */
export function archiveProjects(ids: (string | undefined)[]): string[] {
	const clean = [...new Set(ids.filter((id): id is string => Boolean(id)))].filter(
		(id) => !projectSelectionState.archivedIds.includes(id)
	);
	if (clean.length === 0) return [];
	projectSelectionState.archivedIds = [...projectSelectionState.archivedIds, ...clean];
	// Archived rows leave the main list, so drop them from the selection.
	const remaining = projectSelectionState.selectedIds.filter((id) => !clean.includes(id));
	if (projectSelectionState.active && remaining.length === 0) {
		exitSelectionMode();
	} else {
		projectSelectionState.selectedIds = remaining;
	}
	persistArchivedIds();
	return clean;
}

/** Return projects from the Archived section to the main list. */
export function restoreProjects(ids: (string | undefined)[]): string[] {
	const clean = ids.filter((id): id is string => Boolean(id));
	if (clean.length === 0) return [];
	projectSelectionState.archivedIds = projectSelectionState.archivedIds.filter(
		(id) => !clean.includes(id)
	);
	persistArchivedIds();
	return clean;
}

/** Drop every local reference (selection/pin/archive) — call after a real delete. */
export function pruneProject(projectId: string | undefined): void {
	if (!projectId) return;
	const hadArchived = projectSelectionState.archivedIds.includes(projectId);
	for (const key of ['selectedIds', 'pinnedIds', 'archivedIds'] as const) {
		if (projectSelectionState[key].includes(projectId)) {
			projectSelectionState[key] = projectSelectionState[key].filter((id) => id !== projectId);
		}
	}
	if (hadArchived) persistArchivedIds();
	if (projectSelectionState.active && projectSelectionState.selectedIds.length === 0) {
		exitSelectionMode();
	}
}

/** Main list: archived projects are excluded, pinned stay on top (stored order kept). */
export function visibleProjects(projects: Project[]): Project[] {
	return projects
		.filter((p) => !isProjectArchived(p.id))
		.sort((a, b) => {
			const aPinned = isProjectPinned(a.id) ? 0 : 1;
			const bPinned = isProjectPinned(b.id) ? 0 : 1;
			return aPinned - bPinned;
		});
}

/** Archived section content, in stored order. */
export function archivedProjects(projects: Project[]): Project[] {
	return projects.filter((p) => isProjectArchived(p.id));
}
