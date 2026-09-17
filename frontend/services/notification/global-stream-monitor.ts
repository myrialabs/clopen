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
import { warmNotificationIcon } from '$frontend/services/notification/notification-icon';
import { warmPushServiceWorker } from '$frontend/services/notification/service-worker-notifications';
import { isMobileDevice } from '$frontend/services/notification/service-worker-notifications';
import { ensurePushSubscription } from '$frontend/services/notification/push-subscription.service';
import { settings } from '$frontend/stores/features/settings.svelte';
import { projectState } from '$frontend/stores/core/projects.svelte';
import { debug } from '$shared/utils/logger';
import ws from '$frontend/utils/ws';
import { registerProjectCleanup } from '$frontend/utils/project-state-cleanup';

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

    // Rasterise the notification icon now rather than when a chat finishes,
    // so the first notification of the session is not the one that pays for it.
    warmNotificationIcon();
    // Register the service worker early so the mobile notification route
    // (Chrome on Android, installed PWA on iOS) is ready before the first
    // chat completion needs it. No-op on desktop.
    warmPushServiceWorker();

    // Re-sync the server subscription for users who enabled push before this
    // device was registered (or whose subscription the push service expired).
    // Silent best-effort: the toggle handler reports failures loudly.
    if (
      isMobileDevice() &&
      settings.pushNotifications &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      void ensurePushSubscription().then((result) => {
        if (result === 'failed') {
          debug.warn('notification', 'GlobalStreamMonitor: background push re-sync failed');
        }
      });
    }

    // Stream finished — notify on completion
    ws.on('chat:stream-finished', async (data) => {
      const { projectId, status, chatSessionId, streamId, reason } = data as {
        projectId: string;
        status: string;
        chatSessionId: string;
        streamId?: string;
        reason?: string;
      };

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

      // Shared tag with the server push for the same stream: the background
      // copy replaces this local toast instead of duplicating it. Distinct
      // streams keep distinct tags, so chats never collapse into one toast.
      const tag = streamId ? `chat-${streamId}` : undefined;

      // Send push notification with project context
      try {
        const projectName = projectState.projects.find(p => p.id === projectId)?.name || 'Unknown';

        if (status === 'completed') {
          await pushNotification.sendChatComplete(`Chat response ready in "${projectName}"`, tag);
        } else if (status === 'error') {
          await pushNotification.sendChatError(`Chat error in "${projectName}"`, tag);
        } else if (status === 'cancelled') {
          await pushNotification.sendChatComplete(`Chat interrupted in "${projectName}"`, tag);
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

      // Send push notification. Shared tag with the server push for the
      // same question so the two copies collapse into one toast.
      try {
        const projectName = projectState.projects.find(p => p.id === projectId)?.name || 'Unknown';
        await pushNotification.sendChatComplete(
          `Waiting for your input in "${projectName}"`,
          `waiting-${toolUseId}`
        );
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
   * Clean up notified tool_use IDs for a specific project.
   * Called when a project is removed to prevent memory leaks.
   * Since toolUseIds are global, we clear the entire set as a safety measure.
   */
  cleanupProjectNotifications(): void {
    this.notifiedToolUseIds.clear();
    debug.log('notification', 'GlobalStreamMonitor: Cleared notification state for project cleanup');
  }

  /**
   * Clear all state (for cleanup/testing)
   */
  clear(): void {
    this.notifiedToolUseIds.clear();
    debug.log('notification', 'GlobalStreamMonitor: Clearing all state');
  }
}

// Export singleton instance
export const globalStreamMonitor = new GlobalStreamMonitor();

// Register cleanup with the centralized registry
registerProjectCleanup(() => {
  globalStreamMonitor.cleanupProjectNotifications();
});
