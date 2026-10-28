/**
 * Project Status Data Service
 * Shared logic for getting project status data
 */

import { streamManager, type StreamState } from '../chat/stream-manager.js';
import { sessionQueries } from '../database/queries/session-queries.js';
import type { UnifiedMessage } from '$shared/types/unified';
import { isWaitingForInteractiveInput } from '$shared/utils/interactive-input';

/**
 * Check if an active stream is waiting for user input.
 * Delegates to the shared derivation so backend presence and the frontend
 * chat service can never disagree on what "waiting for input" means.
 * This is the backend single source of truth — works even when the
 * user is on a different project and not receiving chat events.
 */
function detectStreamWaitingInput(stream: StreamState): boolean {
  if (stream.status !== 'active') return false;

  const messages = stream.messages
    .map(event => (event as { message?: UnifiedMessage }).message)
    .filter((msg): msg is UnifiedMessage => Boolean(msg));

  return isWaitingForInteractiveInput(messages);
}

/**
 * Which tree a stream runs in (null = the main project tree).
 * Resolved from the session rather than the stream, because a stream never
 * carries the worktree it was started in — and the callers need it to tell
 * apart "this project is busy" from "this worktree is busy".
 */
function resolveStreamWorktreeId(chatSessionId: string, memo: Map<string, string | null>): string | null {
  const cached = memo.get(chatSessionId);
  if (cached !== undefined) return cached;

  const worktreeId = sessionQueries.getById(chatSessionId)?.worktree_id ?? null;
  memo.set(chatSessionId, worktreeId);
  return worktreeId;
}

function toStreamStatus(stream: StreamState, worktreeMemo: Map<string, string | null>) {
  return {
    streamId: stream.streamId,
    chatSessionId: stream.chatSessionId,
    worktreeId: resolveStreamWorktreeId(stream.chatSessionId, worktreeMemo),
    status: stream.status,
    startedAt: stream.startedAt,
    messagesCount: stream.messages.length,
    isWaitingInput: detectStreamWaitingInput(stream)
  };
}

export interface ProjectStatusData {
  projectId: string;
  hasActiveStreams: boolean;
  activeStreamCount: number;
  streams: ReturnType<typeof toStreamStatus>[];
}

// Get project status data: the chat streams running in a project (or in every
// project), which every device mirrors to show busy/waiting indicators.
export async function getProjectStatusData(projectId: string): Promise<ProjectStatusData>;
export async function getProjectStatusData(): Promise<ProjectStatusData[]>;
export async function getProjectStatusData(projectId?: string): Promise<ProjectStatusData | ProjectStatusData[]> {
  const worktreeMemo = new Map<string, string | null>();

  if (projectId) {
    const allProjectStreams = streamManager.getProjectStreams(projectId);
    const activeStreams = allProjectStreams.filter(s => s.status === 'active');
    return {
      projectId,
      hasActiveStreams: activeStreams.length > 0,
      activeStreamCount: activeStreams.length,
      streams: allProjectStreams.map(s => toStreamStatus(s, worktreeMemo))
    };
  }

  const allProjects = new Map<string, ProjectStatusData>();
  for (const stream of streamManager.getAllStreams()) {
    if (!stream.projectId) continue;
    let projectData = allProjects.get(stream.projectId);
    if (!projectData) {
      projectData = {
        projectId: stream.projectId,
        hasActiveStreams: false,
        activeStreamCount: 0,
        streams: []
      };
      allProjects.set(stream.projectId, projectData);
    }
    if (stream.status === 'active') {
      projectData.hasActiveStreams = true;
      projectData.activeStreamCount++;
    }
    projectData.streams.push(toStreamStatus(stream, worktreeMemo));
  }

  return [...allProjects.values()];
}
