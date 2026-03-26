/**
 * Global Stream Monitor Service
 *
 * Single source of truth for chat stream notifications (sound + push).
 *
 * Listens for backend events and triggers notifications for ALL projects —
 * both active and non-active:
 * - chat:stream-finished  → stream completed/errored/cancelled
 * - chat:waiting-input    → AskUserQuestion requires user input
 *
 * The backend uses ws.emit.projectMembers() so notifications reach users
 * even when they are on a different project or session.
 */

import { soundNotification, pushNotification } from '$frontend/services/notification';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';

class GlobalStreamMonitor {
  private initialized = false;

  /** Track notified AskUserQuestion tool_use IDs to ensure once-only notification */
  private notifiedToolUseIds = new Set<string>();

  /**
   * Initialize the monitor - subscribes to WS events.
   * Safe to call multiple times (idempotent).
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    debug.log('notification', 'GlobalStreamMonitor: Initializing WS listeners');

    // Stream finished — notify on completion
    ws.on('chat:stream-finished', async (data) => {
      const { projectId, status, chatSessionId, reason } = data;

      debug.log('notification', 'GlobalStreamMonitor: Stream finished', { projectId, status, reason });

      // Clean up notified IDs for this session (stream is done)
      this.clearSessionNotifications(chatSessionId);

      // Skip notifications when stream was cancelled due to session deletion
      if (reason === 'session-deleted') return;

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

    // Waiting for input — notify once per AskUserQuestion
    ws.on('chat:waiting-input', async (data) => {
      const { projectId, chatSessionId, toolUseId } = data;

      // Deduplicate: only notify once per tool_use ID
      if (this.notifiedToolUseIds.has(toolUseId)) return;
      this.notifiedToolUseIds.add(toolUseId);

      debug.log('notification', 'GlobalStreamMonitor: Waiting for input', { projectId, chatSessionId, toolUseId });

      // Play sound notification
      try {
        await soundNotification.play();
      } catch (error) {
        debug.error('notification', 'Error playing sound notification:', error);
      }

      // Send push notification
      try {
        const projectName = projectState.projects.find(p => p.id === projectId)?.name || 'Unknown';
        await pushNotification.sendChatComplete(`Waiting for your input in "${projectName}"`);
      } catch (error) {
        debug.error('notification', 'Error sending push notification:', error);
      }
    });
  }

  /**
   * Remove tracked tool_use IDs for a finished session
   */
  private clearSessionNotifications(chatSessionId: string): void {
    // Tool IDs are globally unique, so a simple clear-on-stream-finish
    // is enough — they won't collide across sessions.
    // For long-running apps, periodically trim to avoid unbounded growth.
    if (this.notifiedToolUseIds.size > 500) {
      this.notifiedToolUseIds.clear();
    }
  }

  /**
   * Clear state (for cleanup/testing)
   */
  clear(): void {
    this.notifiedToolUseIds.clear();
    debug.log('notification', 'GlobalStreamMonitor: Clearing state');
  }
}

// Export singleton instance
export const globalStreamMonitor = new GlobalStreamMonitor();
