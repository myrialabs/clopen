/**
 * Snapshot Service - WebSocket Implementation (v2 - Session-Scoped)
 *
 * Provides snapshot/restore functionality using WebSocket.
 * v2 adds conflict detection and session-scoped restore.
 */

import ws from '$frontend/utils/ws';
import type { TimelineResponse } from '$frontend/components/checkpoint/timeline/types';
import type { SessionFileChangeWithStats } from '$shared/types/database/schema';

/**
 * Conflict information for a single file
 */
export interface RestoreConflict {
	filepath: string;
	modifiedBySessionId: string;
	modifiedBySnapshotId: string;
	modifiedAt: string;
	restoreContent?: string;
	currentContent?: string;
	/**
	 * 'cross-session' (default): changed by another session. 'local': current
	 * on-disk content was never checkpointed, so restoring overwrites a manual edit.
	 */
	reason?: 'cross-session' | 'local';
}

/**
 * Result of conflict detection
 */
export interface RestoreConflictCheck {
	hasConflicts: boolean;
	conflicts: RestoreConflict[];
	checkpointsToUndo: string[];
}

/**
 * User's resolution for conflicting files
 */
export type ConflictResolution = Record<string, 'restore' | 'keep'>;

class SnapshotService {
	/**
	 * Get timeline data for a session
	 */
	async getTimeline(sessionId: string): Promise<TimelineResponse> {
		return ws.http('snapshot:get-timeline', { sessionId });
	}

	/**
	 * Check for conflicts before restoring to a checkpoint.
	 * Should be called before restore() to detect cross-session conflicts.
	 */
	async checkConflicts(messageId: string, sessionId: string): Promise<RestoreConflictCheck> {
		return ws.http('snapshot:check-conflicts', { messageId, sessionId });
	}

	/**
	 * Restore to a checkpoint with optional conflict resolutions.
	 */
	async restore(
		messageId: string,
		sessionId: string,
		conflictResolutions?: ConflictResolution
	): Promise<any> {
		return ws.http('snapshot:restore', { messageId, sessionId, conflictResolutions });
	}

	/**
	 * Get changed files for a checkpoint.
	 */
	async getChanges(messageId: string, sessionId: string): Promise<{
		files: SessionFileChangeWithStats[];
	}> {
		return ws.http('snapshot:get-changes', { messageId, sessionId });
	}

	/**
	 * Get old/new file content for diff display.
	 */
	async getFileDiff(messageId: string, filepath: string, sessionId: string): Promise<{
		oldContent: string;
		newContent: string;
		filepath: string;
	}> {
		return ws.http('snapshot:get-file-diff', { messageId, filepath, sessionId });
	}

	/**
	 * Get the dismissed-changes list (per-session marks for files the
	 * user has staged/discarded from the banner). Returns the current
	 * full list of dismissed filepaths.
	 */
	async getDismissedChanges(sessionId: string): Promise<{ files: string[] }> {
		return ws.http('snapshot:get-dismissed-changes', { sessionId }) as Promise<{ files: string[] }>;
	}

	/**
	 * Add one or more filepaths to the latest snapshot's dismissed_changes
	 * list (deduplicated). Returns the resulting full list.
	 */
	async addDismissedChanges(sessionId: string, filepaths: string[]): Promise<{ files: string[] }> {
		return ws.http('snapshot:add-dismissed-changes', { sessionId, filepaths }) as Promise<{ files: string[] }>;
	}

	/**
	 * Clear all dismissed marks for the session. Used when the user
	 * undoes a stage/discard.
	 */
	async clearDismissedChanges(sessionId: string): Promise<{ cleared: boolean }> {
		return ws.http('snapshot:clear-dismissed-changes', { sessionId }) as Promise<{ cleared: boolean }>;
	}

	/**
	 * @deprecated Use restore() instead. Kept for backward compatibility.
	 */
	async undo(messageId: string, sessionId: string): Promise<any> {
		return this.restore(messageId, sessionId);
	}

	/**
	 * @deprecated Use restore() instead. Kept for backward compatibility.
	 */
	async redo(branchName: string, sessionId: string, messageId?: string): Promise<any> {
		if (messageId) {
			return this.restore(messageId, sessionId);
		}
		throw new Error('messageId is required for restore operation');
	}
}

// Export singleton instance
export const snapshotService = new SnapshotService();

// Export class
export { SnapshotService };
