/**
 * Presence Store
 * Shared reactive state for project presence (active users)
 * Subscribes once to projectStatusService, shared across all components
 *
 * Also provides unified helpers for status indicators so all components
 * read from one place (merges backend presence + frontend app state).
 */

import { projectStatusService, type ProjectStatus } from '$frontend/services/project/status.service';
import { userStore } from '$frontend/stores/features/user.svelte';
import { appState, markSessionUnread, hasUnreadSessionsForProject } from '$frontend/stores/core/app.svelte';
import { sessionState } from '$frontend/stores/core/sessions.svelte';

// Shared reactive state
export const presenceState = $state<{
	statuses: Map<string, ProjectStatus>;
}>({
	statuses: new Map()
});

let subscribed = false;

/**
 * Initialize presence subscription (call once at app level)
 * Automatically excludes the current user from activeUsers
 */
export function initPresence() {
	if (subscribed) return;
	subscribed = true;

	projectStatusService.onStatusUpdate((statuses) => {
		const currentUserId = userStore.currentUser?.id;
		const currentSessionId = sessionState.currentSession?.id;
		const statusMap = new Map<string, ProjectStatus>();
		statuses.forEach((status) => {
			statusMap.set(status.projectId, {
				...status,
				activeUsers: currentUserId
					? status.activeUsers.filter((u) => u.userId !== currentUserId)
					: status.activeUsers
			});

			// Mark non-current sessions with active streams as unread
			if (status.streams) {
				for (const stream of status.streams) {
					if (stream.status === 'active' && stream.chatSessionId !== currentSessionId) {
						markSessionUnread(stream.chatSessionId, status.projectId);
					}
				}
			}
		});
		presenceState.statuses = statusMap;
	});
}

/**
 * Get presence status for a specific project
 */
export function getProjectPresence(projectId: string): ProjectStatus | undefined {
	return presenceState.statuses.get(projectId);
}

// ========================================
// UNIFIED STATUS HELPERS
// ========================================

/**
 * Check if a chat session is waiting for user input.
 * Merges two sources so the result is always up-to-date:
 *   1. Frontend appState.sessionStates (instant, set by chat stream events)
 *   2. Backend presenceState (works for background / other-project sessions)
 */
export function isSessionWaitingInput(chatSessionId: string, projectId?: string): boolean {
	// Frontend app state — immediate for the active session
	if (appState.sessionStates[chatSessionId]?.isWaitingInput) return true;

	// Backend presence — covers background & cross-project sessions
	if (projectId) {
		const status = presenceState.statuses.get(projectId);
		if (status?.streams?.some(
			(s: any) => s.status === 'active' && s.chatSessionId === chatSessionId && s.isWaitingInput
		)) return true;
	} else {
		// No projectId provided — search all projects
		for (const status of presenceState.statuses.values()) {
			if (status.streams?.some(
				(s: any) => s.status === 'active' && s.chatSessionId === chatSessionId && s.isWaitingInput
			)) return true;
		}
	}

	return false;
}

/**
 * Get the status indicator color for a project.
 * Priority (highest wins when multiple sessions exist):
 * - Green (bg-emerald-500)  : at least one stream actively processing
 * - Amber (bg-amber-500)    : all active streams waiting for user input
 * - Blue  (bg-blue-500)     : session(s) with unread activity
 * - Gray  (bg-slate-500/30) : idle
 *
 * Merges backend presence with frontend app state for accuracy.
 */
export function getProjectStatusColor(projectId: string): string {
	const status = presenceState.statuses.get(projectId);

	const activeStreams = status?.streams?.filter((s: any) => s.status === 'active') ?? [];

	if (activeStreams.length > 0) {
		// Green wins: at least one stream is actively processing (not waiting)
		const hasProcessing = activeStreams.some((s: any) =>
			!s.isWaitingInput && !appState.sessionStates[s.chatSessionId]?.isWaitingInput
		);
		if (hasProcessing) return 'bg-emerald-500';

		// All active streams are waiting for input
		return 'bg-amber-500';
	}

	// Check for unread sessions in this project, excluding the currently viewed session
	const currentSessionId = sessionState.currentSession?.id;
	if (hasUnreadSessionsForProject(projectId, currentSessionId)) return 'bg-blue-500';

	return 'bg-slate-500/30';
}

