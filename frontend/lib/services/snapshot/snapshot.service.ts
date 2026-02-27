/**
 * Snapshot Service - WebSocket Implementation
 *
 * Provides snapshot/restore functionality using WebSocket
 */

import ws from '$frontend/lib/utils/ws';
import type { TimelineResponse } from '$frontend/lib/components/checkpoint/timeline/types';

class SnapshotService {
  /**
   * Get timeline data for a session
   */
  async getTimeline(sessionId: string): Promise<TimelineResponse> {
    return ws.http('snapshot:get-timeline', { sessionId });
  }

  /**
   * Restore to a checkpoint (unified - replaces undo/redo)
   */
  async restore(messageId: string, sessionId: string): Promise<any> {
    return ws.http('snapshot:restore', { messageId, sessionId });
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
