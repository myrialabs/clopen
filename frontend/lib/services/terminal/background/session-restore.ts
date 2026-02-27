/**
 * Terminal Session Restoration Service
 * Handles restoration of terminal sessions after browser refresh
 */

import { terminalSessionManager } from '../session.service';
import { terminalPersistenceManager } from '../persistence.service';
import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';

interface SessionToReconnect {
	sessionId: string;
	streamId: string;
	command: string;
}

class SessionRestoreService {
	private isRestorationComplete = false;
	private sessionsToReconnect: SessionToReconnect[] = [];

	/**
	 * Check if restoration is done
	 */
	isRestorationDone(): boolean {
		return this.isRestorationComplete;
	}

	/**
	 * Check if there are restored sessions
	 */
	hasRestoredSessions(): boolean {
		const persistedData = terminalPersistenceManager.loadTerminalSessions();
		return persistedData !== null && persistedData.sessions.length > 0;
	}

	/**
	 * Get sessions that need reconnection
	 */
	getSessionsToReconnect(): SessionToReconnect[] {
		return this.sessionsToReconnect;
	}

	/**
	 * Clear sessions to reconnect list
	 */
	clearSessionsToReconnect(): void {
		this.sessionsToReconnect = [];
	}

	/**
	 * Restore terminal sessions from persistence
	 */
	async restoreTerminalSessions(): Promise<void> {
		const persistedData = terminalPersistenceManager.loadTerminalSessions();
		if (!persistedData || persistedData.sessions.length === 0) {
			// If no sessions, then clean up any orphaned stream info
			this.cleanupStaleStreamInfo();
			this.isRestorationComplete = true; // Mark as done even if no sessions
			return;
		}

		// Check if terminal store already has sessions (might be initialized elsewhere)
		const existingSessions = terminalStore.sessions;
		const existingSessionIds = new Set(existingSessions.map(s => s.id));

		// Update nextSessionId based on restored sessions to avoid conflicts
		let maxSessionId = 0;
		for (const persistedSession of persistedData.sessions) {
			const match = persistedSession.sessionId.match(/terminal-(\d+)/);
			if (match) {
				const id = parseInt(match[1], 10);
				if (id > maxSessionId) {
					maxSessionId = id;
				}
			}
		}

		// Update terminal store's nextSessionId if needed
		if (maxSessionId > 0) {
			terminalStore.updateNextSessionId(maxSessionId + 1);
		}

		// Track sessions that need stream reconnection
		const sessionsNeedingReconnect: SessionToReconnect[] = [];

		for (const persistedSession of persistedData.sessions) {
			// Skip if session already exists
			if (existingSessionIds.has(persistedSession.sessionId)) {
				continue;
			}

			// Restore session in session manager
			terminalSessionManager.restoreSession(
				persistedSession.sessionId,
				persistedSession.projectId,
				persistedSession.projectPath,
				persistedSession.workingDirectory,
				[], // outputHistory will be restored from lines
				persistedSession.commandHistory,
				persistedSession.createdAt,
				persistedSession.lastUsedAt
			);

			// Restore session in terminal store
			// Extract terminal number from sessionId (format: projectId-terminal-N or terminal-N)
			const sessionParts = persistedSession.sessionId.split('-');
			const terminalNumber = sessionParts[sessionParts.length - 1] || '1';

			const restoredSession = {
				id: persistedSession.sessionId,
				name: `Terminal ${terminalNumber}`,
				directory: persistedSession.workingDirectory,
				lines: persistedSession.lines || [],
				commandHistory: persistedSession.commandHistory || [],
				isActive: persistedSession.isActive,
				createdAt: persistedSession.createdAt,
				lastUsedAt: persistedSession.lastUsedAt,
				shellType: persistedSession.shellType || 'Unknown',
				terminalBuffer: undefined,
				projectId: persistedSession.projectId,
				projectPath: persistedSession.projectPath
			};

			// Add to terminal store only if it doesn't exist
			terminalStore.addSession(restoredSession);

			// Check if this session was executing and needs reconnection
			if (persistedSession.isExecuting && persistedSession.lastCommand) {
				// Mark this session as restored
				if (typeof window !== 'undefined') {
					sessionStorage.setItem('terminal-restored-' + persistedSession.sessionId, 'true');
				}

				// Add to reconnection list
				// Use streamId if available, otherwise generate one based on sessionId
				const streamId = persistedSession.streamId || `stream-${persistedSession.sessionId}-${Date.now()}`;
				sessionsNeedingReconnect.push({
					sessionId: persistedSession.sessionId,
					streamId: streamId,
					command: persistedSession.lastCommand
				});
			}

			// Note: We don't need to add output history to session manager separately
			// because the lines are already included in restoredSession.lines
			// Adding them again would cause duplication
		}

		// Set active session only if it exists in the restored sessions
		if (persistedData.activeSessionId) {
			const activeSessionExists = terminalStore.sessions.find(s => s.id === persistedData.activeSessionId);
			if (activeSessionExists) {
				terminalStore.setActiveSession(persistedData.activeSessionId);
				terminalSessionManager.setActiveSession(persistedData.activeSessionId);
			} else if (terminalStore.sessions.length > 0) {
				// Set first session as active if specified active session doesn't exist
				const firstSession = terminalStore.sessions[0];
				terminalStore.setActiveSession(firstSession.id);
				terminalSessionManager.setActiveSession(firstSession.id);
			}
		}

		// Mark restoration as complete
		this.isRestorationComplete = true;

		// Store sessions needing reconnect for later processing
		this.sessionsToReconnect = sessionsNeedingReconnect;

		// After restoration complete, clean up truly orphaned stream info
		// This will only remove stream info for sessions that don't exist
		this.cleanupStaleStreamInfo();
	}

	/**
	 * Clean up stale stream info (in-memory)
	 * Only removes stream info that doesn't have corresponding sessions
	 */
	cleanupStaleStreamInfo(): void {
		const validSessionIds = new Set(terminalStore.sessions.map(s => s.id));
		const allStreams = terminalPersistenceManager.getAllActiveStreams();

		for (const stream of allStreams) {
			if (!validSessionIds.has(stream.sessionId)) {
				terminalPersistenceManager.clearStreamInfo(stream.sessionId, stream.streamId);
			}
		}
	}

	/**
	 * Get active streams for reconnection
	 */
	getActiveStreamsForReconnection(): SessionToReconnect[] {
		// Only try to reconnect if we have restored sessions
		const restoredSessions = terminalStore.sessions;
		if (restoredSessions.length === 0) {
			return [];
		}

		const activeStreams: SessionToReconnect[] = [];
		const processedStreamIds = new Set<string>();

		// First, add sessions that were marked as executing during restoration
		if (this.sessionsToReconnect.length > 0) {
			for (const session of this.sessionsToReconnect) {
				activeStreams.push(session);
				processedStreamIds.add(session.streamId);
			}
		}

		// Check persistence manager for all stream info (session-based and streamId-based)
		const allActiveStreams = terminalPersistenceManager.getAllActiveStreams();
		for (const streamInfo of allActiveStreams) {
			// Skip if already processed
			if (processedStreamIds.has(streamInfo.streamId)) {
				continue;
			}

			// IMPORTANT: Only reconnect to streams that belong to current project sessions
			// Don't try to reconnect to streams from other projects during restoration
			let shouldReconnect = false;
			let matchingSessionId: string | null = null;

			for (const session of restoredSessions) {
				// Only match by exact sessionId (not by projectId during initial restoration)
				// This prevents trying to reconnect to other project's streams
				if (streamInfo.sessionId === session.id) {
					shouldReconnect = true;
					matchingSessionId = session.id;
					break;
				}
			}

			if (shouldReconnect && matchingSessionId) {
				activeStreams.push({
					sessionId: matchingSessionId,
					streamId: streamInfo.streamId,
					command: streamInfo.command
				});
				processedStreamIds.add(streamInfo.streamId);
			}
		}

		return activeStreams;
	}

	/**
	 * Save current terminal state
	 */
	saveCurrentState(): void {
		const sessions = terminalStore.sessions;
		const activeSessionId = terminalStore.activeSessionId;

		// Check for duplicates before saving
		const uniqueSessions = new Map<string, any>();
		for (const session of sessions) {
			if (!uniqueSessions.has(session.id)) {
				// Enhance session with execution state from terminalSessionManager
				const sessionState = terminalSessionManager.getSession(session.id);
				const enhancedSession = {
					...session,
					isExecuting: sessionState?.isExecuting || false,
					lastCommand: sessionState?.lastCommand || undefined,
					streamId: sessionState?.streamId || undefined
				};
				uniqueSessions.set(session.id, enhancedSession);
			}
		}

		const cleanSessions = Array.from(uniqueSessions.values());
		terminalPersistenceManager.saveTerminalSessions(cleanSessions, activeSessionId);
	}
}

// Export singleton instance
export const sessionRestoreService = new SessionRestoreService();