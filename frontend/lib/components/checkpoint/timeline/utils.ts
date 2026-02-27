/**
 * Timeline utility functions
 */

import type { TimelineResponse, GraphNode } from './types';

/**
 * Format timestamp to time string (HH:MM)
 */
export function formatTime(timestamp: string): string {
	const date = new Date(timestamp);
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format timestamp to date string (MMM DD, HH:MM)
 */
export function formatDate(timestamp: string): string {
	const date = new Date(timestamp);
	return date.toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	});
}

/**
 * Check if checkpoint is current HEAD
 */
export function isCurrentHead(
	timelineData: TimelineResponse | null,
	checkpointId: string
): boolean {
	return timelineData?.currentHeadId === checkpointId;
}

/**
 * Get sorted nodes for Z-index (restoring node rendered last, on top)
 */
export function getSortedNodes(
	graphNodes: GraphNode[],
	isAnimating: boolean,
	restoringNodeId: string | null
): GraphNode[] {
	if (isAnimating && restoringNodeId) {
		return [
			...graphNodes.filter(n => n.id !== restoringNodeId),
			...graphNodes.filter(n => n.id === restoringNodeId)
		];
	}
	return graphNodes;
}
