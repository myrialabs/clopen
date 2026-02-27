/**
 * Presence Store
 * Shared reactive state for project presence (active users)
 * Subscribes once to projectStatusService, shared across all components
 */

import { onMount } from 'svelte';
import { projectStatusService, type ProjectStatus } from '$frontend/lib/services/project/status.service';
import { userStore } from '$frontend/lib/stores/features/user.svelte';

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
		const statusMap = new Map<string, ProjectStatus>();
		statuses.forEach((status) => {
			statusMap.set(status.projectId, {
				...status,
				activeUsers: currentUserId
					? status.activeUsers.filter((u) => u.userId !== currentUserId)
					: status.activeUsers
			});
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
