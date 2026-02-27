/**
 * Project Status Service
 * Tracks active streams and user presence for projects via WebSocket
 * Fully realtime - no cache, no polling
 *
 * Single event: `projects:presence-updated` contains full state
 */

import { getOrCreateAnonymousUser, type AnonymousUser } from '$shared/utils/anonymous-user';
import ws from '$frontend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export interface ProjectStatus {
  projectId: string;
  hasActiveStreams: boolean;
  activeStreamCount: number;
  activeUsers: { userId: string; userName: string }[];
  streams: {
    streamId: string;
    chatSessionId: string;
    status: string;
    startedAt: string;
    messagesCount: number;
  }[];
  /** Per-chat-session user presence: { chatSessionId → users[] } */
  chatSessionUsers?: Record<string, { userId: string; userName: string }[]>;
}

class ProjectStatusService {
  private currentUser: AnonymousUser | null = null;
  private currentProjectId: string | null = null;
  private initialized = false;
  private statusUpdateCallbacks: Set<(statuses: ProjectStatus[]) => void> = new Set();
  private unsubscribe: (() => void) | null = null;

  /**
   * Initialize the service - sets up WS listener
   * Called automatically on first use
   */
  async initialize(): Promise<void> {
    if (typeof window === 'undefined' || this.initialized) return;

    this.currentUser = await getOrCreateAnonymousUser();
    debug.log('project', 'Initialized with user:', this.currentUser?.name);

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
        debug.error('project', 'Error handling presence update:', error);
      }
    });

    this.initialized = true;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Subscribe to real-time presence updates
   * Auto-initializes WS listener if not done yet
   */
  onStatusUpdate(callback: (statuses: ProjectStatus[]) => void): () => void {
    this.statusUpdateCallbacks.add(callback);
    this.ensureInitialized();

    return () => {
      this.statusUpdateCallbacks.delete(callback);
    };
  }

  /**
   * Join a project - start presence tracking
   */
  async startTracking(projectId: string): Promise<void> {
    if (typeof window === 'undefined') return;

    await this.ensureInitialized();

    if (this.currentProjectId && this.currentProjectId !== projectId) {
      await this.stopTracking();
    }

    this.currentProjectId = projectId;

    if (this.currentUser) {
      ws.emit('projects:join', {
        userName: this.currentUser.name
      });
    }

    document.addEventListener('visibilitychange', this.handleVisibilityChange);
    window.addEventListener('beforeunload', this.handleBeforeUnload);
  }

  /**
   * Leave a project - stop presence tracking
   */
  async stopTracking(): Promise<void> {
    if (this.currentProjectId && this.currentUser) {
      // Send projectId explicitly because ws.setProject() may have already changed context
      ws.emit('projects:leave', {
        projectId: this.currentProjectId
      });
    }

    if (typeof window !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
      window.removeEventListener('beforeunload', this.handleBeforeUnload);
    }

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

  private handleVisibilityChange = () => {
    if (!document.hidden && this.currentProjectId && this.currentUser) {
      ws.http('projects:update-presence', {
        userName: this.currentUser.name,
        action: 'update'
      }).catch(() => {});
    }
  };

  private handleBeforeUnload = () => {
    if (this.currentProjectId && this.currentUser) {
      ws.emit('projects:leave', {
        projectId: this.currentProjectId
      });
    }
  };

  getCurrentUser(): AnonymousUser | null {
    return this.currentUser;
  }
}

export const projectStatusService = new ProjectStatusService();
