/**
 * Terminal Persistence Manager
 * Manages persistence of terminal sessions in memory
 * Terminal state is ephemeral - rebuilt from server on page refresh
 *
 * No localStorage usage - all state is in-memory only
 */

import type { TerminalSession, TerminalLine } from '$shared/types/terminal';
import { debug } from '$shared/utils/logger';

export interface PersistedTerminalSession {
	sessionId: string;
	projectId?: string;
	projectPath?: string;
	workingDirectory: string;
	lines: TerminalLine[];
	commandHistory: string[];
	createdAt: Date;
	lastUsedAt: Date;
	shellType: string;
	isActive: boolean;
	streamId?: string;
	isExecuting?: boolean;
	lastCommand?: string;
}

export interface TerminalPersistenceData {
	sessions: PersistedTerminalSession[];
	activeSessionId: string | null;
	lastUpdated: Date;
}

interface ActiveStreamInfo {
	streamId: string;
	sessionId: string;
	command: string;
	startedAt: string;
	status: string;
	timestamp: string;
	projectId?: string;
}

const MAX_LINES_TO_PERSIST = 1000; // Limit lines per session
const MAX_HISTORY_TO_PERSIST = 500; // Limit command history

class TerminalPersistenceManager {
	// In-memory storage (replaces localStorage)
	private persistedData: TerminalPersistenceData | null = null;
	private activeStreamsBySession = new Map<string, ActiveStreamInfo>();
	private sessionByStreamId = new Map<string, string>(); // reverse lookup: streamId → sessionId

	/**
	 * Save terminal sessions (in-memory)
	 */
	saveTerminalSessions(sessions: TerminalSession[], activeSessionId: string | null): void {
		this.persistedData = {
			sessions: sessions.map(session => ({
				sessionId: session.id,
				projectId: session.projectId,
				projectPath: session.projectPath,
				workingDirectory: session.directory,
				lines: session.lines.slice(-MAX_LINES_TO_PERSIST),
				commandHistory: session.commandHistory.slice(-MAX_HISTORY_TO_PERSIST),
				createdAt: session.createdAt,
				lastUsedAt: session.lastUsedAt,
				shellType: session.shellType || 'Unknown',
				isActive: session.isActive,
				streamId: (session as any).streamId,
				isExecuting: (session as any).isExecuting,
				lastCommand: (session as any).lastCommand
			})),
			activeSessionId,
			lastUpdated: new Date()
		};
	}

	/**
	 * Load terminal sessions (from memory)
	 */
	loadTerminalSessions(): TerminalPersistenceData | null {
		return this.persistedData;
	}

	/**
	 * Save active stream information for a session (in-memory)
	 */
	saveActiveStream(sessionId: string, streamId: string, command: string, projectId?: string): void {
		const streamInfo: ActiveStreamInfo = {
			streamId,
			sessionId,
			command,
			startedAt: new Date().toISOString(),
			status: 'active',
			timestamp: new Date().toISOString(),
			projectId
		};

		this.activeStreamsBySession.set(sessionId, streamInfo);
		this.sessionByStreamId.set(streamId, sessionId);
	}

	/**
	 * Get active stream information for a session
	 */
	getActiveStream(sessionId: string): { streamId: string; command: string; startedAt: string; projectId?: string } | null {
		const info = this.activeStreamsBySession.get(sessionId);
		if (!info) return null;
		return {
			streamId: info.streamId,
			command: info.command,
			startedAt: info.startedAt,
			projectId: info.projectId
		};
	}

	/**
	 * Get active stream by streamId (for cross-project lookup)
	 */
	getActiveStreamByStreamId(streamId: string): { streamId: string; sessionId: string; command: string; startedAt: string; projectId?: string } | null {
		const sessionId = this.sessionByStreamId.get(streamId);
		if (!sessionId) return null;
		const info = this.activeStreamsBySession.get(sessionId);
		if (!info) return null;
		return {
			streamId: info.streamId,
			sessionId: info.sessionId,
			command: info.command,
			startedAt: info.startedAt,
			projectId: info.projectId
		};
	}

	/**
	 * Clear stream information for a session
	 */
	clearStreamInfo(sessionId: string, streamId?: string): void {
		debug.log('terminal', `🗑️ [persistence] Clearing stream info for session: ${sessionId}`);

		const existingInfo = this.activeStreamsBySession.get(sessionId);
		if (existingInfo) {
			this.sessionByStreamId.delete(existingInfo.streamId);
		}
		this.activeStreamsBySession.delete(sessionId);

		if (streamId) {
			this.sessionByStreamId.delete(streamId);
		}

		debug.log('terminal', `🗑️ [persistence] Stream info cleared for session: ${sessionId}`);
	}

	/**
	 * Remove a specific session from persisted data
	 * Called when terminal tab is closed to prevent restoration after refresh
	 */
	removeSession(sessionId: string): void {
		debug.log('terminal', `🗑️ [persistence] Removing session from persistence: ${sessionId}`);

		if (this.persistedData) {
			const originalCount = this.persistedData.sessions.length;
			this.persistedData.sessions = this.persistedData.sessions.filter(s => s.sessionId !== sessionId);
			const newCount = this.persistedData.sessions.length;

			debug.log('terminal', `🗑️ [persistence] Sessions before: ${originalCount}, after: ${newCount}`);

			// Update active session if needed
			if (this.persistedData.activeSessionId === sessionId) {
				this.persistedData.activeSessionId = this.persistedData.sessions[0]?.sessionId || null;
				debug.log('terminal', `🗑️ [persistence] Updated activeSessionId to: ${this.persistedData.activeSessionId}`);
			}
		}

		// Also clear stream info
		this.clearStreamInfo(sessionId);

		debug.log('terminal', `🗑️ [persistence] Session removed successfully: ${sessionId}`);
	}

	/**
	 * Check if there are any active streams
	 */
	hasActiveStreams(): boolean {
		for (const info of this.activeStreamsBySession.values()) {
			if (info.status === 'active') {
				return true;
			}
		}
		return false;
	}

	/**
	 * Get all active streams
	 */
	getAllActiveStreams(): Array<{ sessionId: string; streamId: string; command: string; timestamp?: string; projectId?: string }> {
		const streams: Array<{ sessionId: string; streamId: string; command: string; timestamp?: string; projectId?: string }> = [];
		const processedStreamIds = new Set<string>();

		for (const [_, streamInfo] of this.activeStreamsBySession) {
			if (streamInfo.status === 'active' && !processedStreamIds.has(streamInfo.streamId)) {
				streams.push({
					sessionId: streamInfo.sessionId,
					streamId: streamInfo.streamId,
					command: streamInfo.command,
					timestamp: streamInfo.timestamp || streamInfo.startedAt,
					projectId: streamInfo.projectId
				});
				processedStreamIds.add(streamInfo.streamId);
			}
		}

		return streams;
	}

	/**
	 * Clear old sessions to free up memory
	 */
	clearOldSessions(): void {
		if (!this.persistedData) return;

		// Keep only last 5 sessions
		const recentSessions = this.persistedData.sessions
			.sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime())
			.slice(0, 5);

		// Further limit lines for old sessions
		recentSessions.forEach(session => {
			session.lines = session.lines.slice(-500);
			session.commandHistory = session.commandHistory.slice(-100);
		});

		this.persistedData.sessions = recentSessions;
	}

	/**
	 * Clear all terminal persistence data
	 */
	clearAll(): void {
		this.persistedData = null;
		this.activeStreamsBySession.clear();
		this.sessionByStreamId.clear();
	}

	/**
	 * Get persistence data size (returns 0 - in-memory only)
	 */
	getDataSize(): number {
		return 0;
	}

	/**
	 * Check if persistence is available (always true for in-memory)
	 */
	isAvailable(): boolean {
		return true;
	}
}

// Export singleton instance
export const terminalPersistenceManager = new TerminalPersistenceManager();
