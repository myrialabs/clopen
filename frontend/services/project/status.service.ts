/**
 * Project Status Service
 * Tracks the chat streams running in every project via WebSocket, so every
 * device shows the same busy / waiting-for-input indicators.
 * Fully realtime - no cache, no polling
 *
 * Single event: `projects:presence-updated` contains full state
 */

import ws, { onWsReconnect } from '$frontend/utils/ws';
import { debug } from '$shared/utils/logger';

export interface ProjectStatus {
  projectId: string;
  hasActiveStreams: boolean;
  activeStreamCount: number;
  streams: {
    streamId: string;
    chatSessionId: string;
    /** Worktree the stream runs in; null = the main project tree. */
    worktreeId?: string | null;
    status: string;
    startedAt: string;
    messagesCount: number;
    isWaitingInput?: boolean;
  }[];
}

class ProjectStatusService {
  private currentProjectId: string | null = null;
  private initialized = false;
  private statusUpdateCallbacks: Set<(statuses: ProjectStatus[]) => void> = new Set();
  private unsubscribe: (() => void) | null = null;

  /**
   * Initialize the service - sets up WS listener
   * Called automatically on first use
   */
  initialize(): void {
    if (typeof window === 'undefined' || this.initialized) return;

    // Re-join after WebSocket reconnection. Without this, the new connection
    // receives no initial status and panels (Git, Terminal, Preview, etc.)
    // miss what is running.
    onWsReconnect(() => {
      if (this.currentProjectId) {
        ws.emit('projects:join', {});
        debug.log('project', 'Re-joined project status after reconnection');
      }
    });

    this.unsubscribe = ws.on('projects:presence-updated', (data) => {
      try {
        if (data.type === 'presence-updated' && data.data) {
          const statuses = Array.isArray(data.data) ? data.data : [data.data];
          this.statusUpdateCallbacks.forEach(callback => {
            try {
              callback(statuses);
            } catch (error) {
              debug.error('project', 'Error in status callback:', error);
            }
          });
        }
      } catch (error) {
        debug.error('project', 'Error handling status update:', error);
      }
    });

    this.initialized = true;
  }

  /**
   * Subscribe to real-time status updates
   * Auto-initializes WS listener if not done yet
   */
  onStatusUpdate(callback: (statuses: ProjectStatus[]) => void): () => void {
    this.statusUpdateCallbacks.add(callback);
    this.initialize();

    return () => {
      this.statusUpdateCallbacks.delete(callback);
    };
  }

  /**
   * A project was opened on this device - request the current status
   */
  startTracking(projectId: string): void {
    if (typeof window === 'undefined') return;

    this.initialize();
    this.currentProjectId = projectId;
    ws.emit('projects:join', {});
  }

  /**
   * The project was closed on this device
   */
  stopTracking(): void {
    this.currentProjectId = null;
  }

  cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.statusUpdateCallbacks.clear();
    this.initialized = false;
  }
}

export const projectStatusService = new ProjectStatusService();
