/**
 * Project Selection Store
 * Single SSOT for the sidebar PROJECTS selection mode, pins, and archive.
 *
 * - Inactive by default: no checkbox is rendered.
 * - `enterSelectionMode()` activates it (checkboxes appear).
 * - `exitSelectionMode()` clears the set and returns the sidebar to normal.
 * - `toggleProject`, `selectAll`, `clearSelection` share the same Set,
 *   so Select All / individual / Delete / Archive always agree.
 * - Pin and Archive are local-only (no backend call, sessions/data untouched)
 *   and persisted server-side via `user:save-state` like the project order,
 *   so both survive a reload. Archived projects leave the main list and live
 *   in the Archived section.
 */

import ws from '$frontend/utils/ws';
import {
	areAllOf,
	cleanIds,
	newlyArchived,
	retainIds,
	sortPinnedFirst,
	toggleAllOf,
	toggleId
} from '$frontend/utils/project-list';
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

export function toggleProjectSelection(projectId: string | undefined): void {
	if (!projectId) return;
	if (!projectSelectionState.active) projectSelectionState.active = true;
	// Deselecting only unchecks — it never leaves Selection Mode. Exiting
	// (which also clears all picks) is exclusively via exitSelectionMode(),
	// wired to the ✕ button.
	projectSelectionState.selectedIds = toggleId(projectSelectionState.selectedIds, projectId);
}

/**
 * Drop picks that are no longer in the list the toolbar is counting against.
 * Without this, typing in the search box leaves rows selected that the user
 * can no longer see — the counter reads "4/1" and Delete hits hidden projects.
 */
export function retainSelection(ids: (string | undefined)[]): void {
	if (!projectSelectionState.active || projectSelectionState.selectedIds.length === 0) return;
	const next = retainIds(projectSelectionState.selectedIds, ids);
	// Only assign on a real change — this runs inside an $effect that reads
	// selectedIds, so an unconditional write would re-invalidate itself.
	if (next.length !== projectSelectionState.selectedIds.length) {
		projectSelectionState.selectedIds = next;
	}
}

/** Toggle Select All: select visible when partial/none, clear when all selected. */
export function toggleSelectAllProjects(ids: (string | undefined)[]): void {
	projectSelectionState.active = true;
	projectSelectionState.selectedIds = toggleAllOf(projectSelectionState.selectedIds, ids);
}

export function areAllSelected(ids: (string | undefined)[]): boolean {
	return areAllOf(projectSelectionState.selectedIds, ids);
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
	persistIds('pinnedProjectIds', projectSelectionState.pinnedIds);
}

export function restorePinnedIds(ids: unknown): void {
	projectSelectionState.pinnedIds = toStringArray(ids);
}

export function isProjectArchived(projectId: string | undefined): boolean {
	if (!projectId) return false;
	return projectSelectionState.archivedIds.includes(projectId);
}

function toStringArray(ids: unknown): string[] {
	return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

function persistIds(key: 'pinnedProjectIds' | 'archivedProjectIds', ids: string[]): void {
	ws.http('user:save-state', { key, value: [...ids] }).catch((err) => {
		debug.error('project', `Error saving ${key} to server:`, err);
	});
}

function persistArchivedIds(): void {
	persistIds('archivedProjectIds', projectSelectionState.archivedIds);
}

export function restoreArchivedIds(ids: unknown): void {
	projectSelectionState.archivedIds = toStringArray(ids);
}

/** Move projects to the Archived section (local only, sessions/data untouched). */
export function archiveProjects(ids: (string | undefined)[]): string[] {
	const clean = newlyArchived(projectSelectionState.archivedIds, ids);
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
	const clean = cleanIds(ids);
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
	const hadPinned = projectSelectionState.pinnedIds.includes(projectId);
	const hadArchived = projectSelectionState.archivedIds.includes(projectId);
	for (const key of ['selectedIds', 'pinnedIds', 'archivedIds'] as const) {
		if (projectSelectionState[key].includes(projectId)) {
			projectSelectionState[key] = projectSelectionState[key].filter((id) => id !== projectId);
		}
	}
	if (hadPinned) persistIds('pinnedProjectIds', projectSelectionState.pinnedIds);
	if (hadArchived) persistArchivedIds();
	if (projectSelectionState.active && projectSelectionState.selectedIds.length === 0) {
		exitSelectionMode();
	}
}

/** Main list: archived projects are excluded, pinned stay on top (stored order kept). */
export function visibleProjects(projects: Project[]): Project[] {
	return sortPinnedFirst(
		projects.filter((p) => !isProjectArchived(p.id)),
		projectSelectionState.pinnedIds
	);
}

/** Archived section content, in stored order. */
export function archivedProjects(projects: Project[]): Project[] {
	return projects.filter((p) => isProjectArchived(p.id));
}
