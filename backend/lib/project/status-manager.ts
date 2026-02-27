/**
 * Project Status Data Service
 * Shared logic for getting project status data
 */

import { streamManager } from '../chat/stream-manager.js';
import { ws } from '../utils/ws.js';

// Store active users per project (shared with main endpoint)
const projectUsers = new Map<string, Set<{ userId: string; userName: string; lastSeen: number }>>();

// Cleanup inactive users after 5 minutes
const USER_TIMEOUT = 5 * 60 * 1000;

function cleanupInactiveUsers() {
  const now = Date.now();
  projectUsers.forEach((users, projectId) => {
    const activeUsers = new Set([...users].filter(user => now - user.lastSeen < USER_TIMEOUT));
    if (activeUsers.size === 0) {
      projectUsers.delete(projectId);
    } else {
      projectUsers.set(projectId, activeUsers);
    }
  });
}

// Get project status data
export async function getProjectStatusData(projectId?: string) {
  cleanupInactiveUsers();
  
  if (projectId) {
    // Get status for specific project
    const allProjectStreams = streamManager.getProjectStreams(projectId);
    const users = projectUsers.get(projectId);

    // Filter to only count active streams
    const activeStreams = allProjectStreams.filter(s => s.status === 'active');

    // Get per-chat-session user presence from WS rooms
    const chatSessionUsers = ws.getProjectChatSessions(projectId);

    return {
      projectId,
      hasActiveStreams: activeStreams.length > 0,
      activeStreamCount: activeStreams.length,
      activeUsers: users ? [...users].map(u => ({
        userId: u.userId,
        userName: u.userName
      })) : [],
      streams: allProjectStreams.map(s => ({
        streamId: s.streamId,
        chatSessionId: s.chatSessionId,
        status: s.status,
        startedAt: s.startedAt,
        messagesCount: s.messages.length
      })),
      chatSessionUsers: Object.fromEntries(
        Array.from(chatSessionUsers.entries()).map(([csId, csUsers]) => [
          csId,
          csUsers.map(u => {
            // Resolve userName from projectUsers
            const projectUser = users ? [...users].find(pu => pu.userId === u.userId) : undefined;
            return { userId: u.userId, userName: projectUser?.userName || u.userId };
          })
        ])
      )
    };
  } else {
    // Get status for all projects
    const allProjects = new Map<string, any>();
    
    // Get all active streams grouped by project
    const allStreams = streamManager.getAllStreams();
    allStreams.forEach(stream => {
      if (stream.projectId) {
        if (!allProjects.has(stream.projectId)) {
          allProjects.set(stream.projectId, {
            projectId: stream.projectId,
            hasActiveStreams: false,
            activeStreamCount: 0,
            activeUsers: [],
            streams: []
          });
        }
        
        const projectData = allProjects.get(stream.projectId);
        if (stream.status === 'active') {
          projectData.hasActiveStreams = true;
          projectData.activeStreamCount++;
        }
        projectData.streams.push({
          streamId: stream.streamId,
          chatSessionId: stream.chatSessionId,
          status: stream.status,
          startedAt: stream.startedAt,
          messagesCount: stream.messages.length
        });
      }
    });
    
    // Add active users to each project
    projectUsers.forEach((users, projectId) => {
      if (!allProjects.has(projectId)) {
        allProjects.set(projectId, {
          projectId,
          hasActiveStreams: false,
          activeStreamCount: 0,
          activeUsers: [],
          streams: [],
          chatSessionUsers: {}
        });
      }

      const projectData = allProjects.get(projectId);
      projectData.activeUsers = [...users].map(u => ({
        userId: u.userId,
        userName: u.userName
      }));
    });

    // Add per-chat-session user presence to each project
    for (const [projectId, projectData] of allProjects) {
      const chatSessionUsers = ws.getProjectChatSessions(projectId);
      const users = projectUsers.get(projectId);
      projectData.chatSessionUsers = Object.fromEntries(
        Array.from(chatSessionUsers.entries()).map(([csId, csUsers]) => [
          csId,
          csUsers.map(u => {
            const projectUser = users ? [...users].find(pu => pu.userId === u.userId) : undefined;
            return { userId: u.userId, userName: projectUser?.userName || u.userId };
          })
        ])
      );
    }

    return [...allProjects.values()];
  }
}

// Update user presence
export function updateUserPresence(projectId: string, userId: string, userName: string, action: string) {
  cleanupInactiveUsers();
  
  if (action === 'leave') {
    // Remove user from project
    const users = projectUsers.get(projectId);
    if (users) {
      const updatedUsers = new Set([...users].filter(u => u.userId !== userId));
      if (updatedUsers.size === 0) {
        projectUsers.delete(projectId);
      } else {
        projectUsers.set(projectId, updatedUsers);
      }
    }
  } else {
    // Add or update user presence
    if (!projectUsers.has(projectId)) {
      projectUsers.set(projectId, new Set());
    }
    
    const users = projectUsers.get(projectId)!;
    // Remove old entry if exists
    const updatedUsers = new Set([...users].filter(u => u.userId !== userId));
    // Add new entry with updated timestamp
    updatedUsers.add({
      userId,
      userName,
      lastSeen: Date.now()
    });
    projectUsers.set(projectId, updatedUsers);
  }
  
  // Return current users for the project
  const currentUsers = projectUsers.get(projectId);
  return {
    projectId,
    activeUsers: currentUsers ? [...currentUsers].map(u => ({ 
      userId: u.userId, 
      userName: u.userName 
    })) : []
  };
}