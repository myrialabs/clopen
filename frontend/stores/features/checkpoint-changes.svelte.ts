/**
 * Checkpoint Changes Banner State
 *
 * When a user clicks a checkpoint node, the changes list is shown
 * as a banner above the chat input.
 */

import type { SessionFileChangeWithStats } from '$shared/types/database/schema';
import { snapshotService } from '$frontend/services/snapshot/snapshot.service';
import { projectState } from '$frontend/stores/core/projects.svelte';
import ws from '$frontend/utils/ws';

export type CheckpointFile = SessionFileChangeWithStats;

export const checkpointChanges = $state<{
	visible: boolean;
	messageText: string;
	files: CheckpointFile[];
	loading: boolean;
}>({
	visible: false,
	messageText: '',
	files: [],
	loading: false
});

/** Aggregate line counts across all visible files — rendered in the
 *  banner header as `+Σadditions  -Σdeletions` so the user gets a
 *  glanceable total like `git diff --stat`. */
export function getTotalAdditions(): number {
	let total = 0;
	for (const f of checkpointChanges.files) total += f.additions ?? 0;
	return total;
}

export function getTotalDeletions(): number {
	let total = 0;
	for (const f of checkpointChanges.files) total += f.deletions ?? 0;
	return total;
}

export const changesExpanded = $state({ value: false });

export function toggleChangesExpanded() {
	changesExpanded.value = !changesExpanded.value;
}

export function showCheckpointChanges(messageText: string, files: CheckpointFile[]) {
	changesExpanded.value = true;
	checkpointChanges.visible = true;
	checkpointChanges.messageText = messageText;
	checkpointChanges.files = files;
	checkpointChanges.loading = false;
}

export function hideCheckpointChanges() {
	checkpointChanges.visible = false;
	checkpointChanges.files = [];
}

// Checkpoint diff to open in git panel
export const checkpointDiff = $state<{ data: { filepath: string; oldContent: string; newContent: string } | null }>({ data: null });

/** Which file the user last clicked in the banner. Persists after
 *  `checkpointDiff.data` is cleared by the GitPanel watcher so the
 *  active-row highlight stays on the file being viewed. */
export const activeCheckpointFile = $state<{ path: string | null }>({ path: null });

export function requestCheckpointDiff(filepath: string, oldContent: string, newContent: string) {
	activeCheckpointFile.path = filepath;
	checkpointDiff.data = { filepath, oldContent, newContent };
}

export function clearCheckpointDiff() {
	checkpointDiff.data = null;
}

export function clearActiveCheckpointFile() {
	activeCheckpointFile.path = null;
}

// ============================================================
// Dismissed-file marks (stored in snapshot DB)
// ============================================================
//
// The banner above chat only shows AI-modified files that the user hasn't
// yet acted on. When the user stages or discards a file via the Git panel
// we add it to the latest snapshot's `dismissed_changes` list — the banner
// then hides it, but `session_changes` in the DB stays intact so
// checkpoint restore still works. Stored in DB so it syncs across
// devices and survives logout/clear-browser-data.
// ============================================================

export const dismissedFiles = $state<{ bySession: Record<string, string[]> }>({
	bySession: {}
});

/**
 * Mark a single file as dismissed for the given session. Persists to
 * the snapshot's `dismissed_changes` list in the DB.
 */
export async function dismissCheckpointFile(sessionId: string, filepath: string): Promise<void> {
	const bucket = dismissedFiles.bySession[sessionId] ?? [];
	if (bucket.includes(filepath)) return;
	const result = await snapshotService.addDismissedChanges(sessionId, [filepath]);
	dismissedFiles.bySession[sessionId] = result.files;
}

/**
 * Mark a batch of files as dismissed for the given session.
 */
export async function dismissCheckpointFiles(sessionId: string, filepaths: string[]): Promise<void> {
	if (filepaths.length === 0) return;
	const result = await snapshotService.addDismissedChanges(sessionId, filepaths);
	dismissedFiles.bySession[sessionId] = result.files;
}

/**
 * Clear all dismissed marks for a session (e.g. when the user undoes a stage).
 */
export async function clearDismissedFiles(sessionId: string): Promise<void> {
	await snapshotService.clearDismissedChanges(sessionId);
	delete dismissedFiles.bySession[sessionId];
}

/** Load the dismissed-changes list for a session from the DB into local state. */
export async function loadDismissedFiles(sessionId: string): Promise<string[]> {
	const result = await snapshotService.getDismissedChanges(sessionId);
	dismissedFiles.bySession[sessionId] = result.files;
	return result.files;
}

/** True when the file has been marked dismissed for this session. */
export function isCheckpointFileDismissed(sessionId: string, filepath: string): boolean {
	return dismissedFiles.bySession[sessionId]?.includes(filepath) ?? false;
}

/**
 * Re-fetch the current checkpoint's `session_changes`, cross-reference with
 * the live git status + dismissed marks, and update the banner to show only
 * files that are still unstaged AND not marked dismissed. Called both on
 * initial session mount (via the ChatPanel auto-load effect) and after
 * staging/discard operations so the banner stays in sync with the worktree.
 *
 * If no visible files remain, the banner is hidden.
 */
export async function refreshCheckpointBanner(sessionId: string): Promise<void> {
	const projectId = projectState.currentProject?.id;
	if (!projectId) return;

	const [timeline, status, dismissedResult] = await Promise.all([
		snapshotService.getTimeline(sessionId),
		ws.http('git:status', { projectId }).catch(() => null) as Promise<{ staged?: { path: string }[] } | null>,
		snapshotService.getDismissedChanges(sessionId)
	]);
	const dismissed = dismissedResult.files;
	dismissedFiles.bySession[sessionId] = dismissed;

	const headId = timeline.currentHeadId;
	if (!headId || headId === '__initial__') {
		hideCheckpointChanges();
		return;
	}

	const result = await snapshotService.getChanges(headId, sessionId);

	// Drop files that are already staged in the worktree — the banner only
	// tracks the live "current state", so a `git add` (or a Git panel stage
	// click) should make those rows disappear.
	const stagedPaths = new Set<string>();
	if (status?.staged) {
		for (const f of status.staged) stagedPaths.add(f.path);
	}

	// Drop files the user has explicitly marked dismissed (e.g. staged via
	// the Git panel) — the mark lives in the snapshot's `dismissed_changes`
	// column so it syncs across devices and survives refresh.
	const dismissedSet = new Set(dismissed);

	const visibleFiles = result.files.filter(f =>
		!stagedPaths.has(f.filepath) && !dismissedSet.has(f.filepath)
	);

	if (visibleFiles.length === 0) {
		hideCheckpointChanges();
		return;
	}

	showCheckpointChanges('Current state', visibleFiles);
}
