/**
 * Global Stream Monitor Service
 *
 * Single source of truth for chat stream notifications (sound + push).
 *
 * Listens for chat:stream-finished events from the backend and triggers
 * notifications for ALL projects — both active and non-active.
 *
 * The backend uses ws.emit.projectMembers() to send this event to all
 * users who have been associated with the project, even if they switched
 * to a different project.
 */

import { soundNotification, pushNotification } from '$frontend/lib/services/notification';
import { projectState } from '$frontend/lib/stores/core/projects.svelte';
import { sessionState } from '$frontend/lib/stores/core/sessions.svelte';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/lib/utils/ws';

class GlobalStreamMonitor {
  private initialized = false;

  /**
   * Initialize the monitor - subscribes to the WS event.
   * Safe to call multiple times (idempotent).
   *
   * Only triggers sound/push when the finished stream belongs to the
   * user's current project AND current chat session.
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    debug.log('notification', 'GlobalStreamMonitor: Initializing WS listener');

    ws.on('chat:stream-finished', async (data) => {
      const { projectId, chatSessionId, status, timestamp } = data;
      const isActiveProject = projectState.currentProject?.id === projectId;
      const isActiveSession = sessionState.currentSession?.id === chatSessionId;

      debug.log('notification', 'GlobalStreamMonitor: Stream finished', {
        projectId,
        chatSessionId,
        status,
        timestamp,
        isActiveProject,
        isActiveSession
      });

      // Only notify if the stream is for the user's current project AND session
      if (!isActiveProject || !isActiveSession) return;

      // Play sound notification
      try {
        await soundNotification.play();
      } catch (error) {
        debug.error('notification', 'Error playing sound notification:', error);
      }

      // Send push notification with project context
      try {
        const projectName = projectState.projects.find(p => p.id === projectId)?.name || 'Unknown';

        if (status === 'completed') {
          await pushNotification.sendChatComplete(`Chat response ready in "${projectName}"`);
        } else if (status === 'error') {
          await pushNotification.sendChatError(`Chat error in "${projectName}"`);
        } else if (status === 'cancelled') {
          await pushNotification.sendChatComplete(`Chat interrupted in "${projectName}"`);
        }
      } catch (error) {
        debug.error('notification', 'Error sending push notification:', error);
      }
    });
  }

  /**
   * Clear state (for cleanup/testing)
   */
  clear(): void {
    debug.log('notification', 'GlobalStreamMonitor: Clearing state');
  }
}

// Export singleton instance
export const globalStreamMonitor = new GlobalStreamMonitor();
