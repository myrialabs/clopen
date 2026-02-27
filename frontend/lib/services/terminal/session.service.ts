/**
 * Terminal Session Manager
 * Manages multiple isolated terminal sessions with proper state tracking
 */

interface TerminalSessionState {
	id: string;
	projectId?: string;
	projectPath?: string;
	workingDirectory: string;
	isExecuting: boolean;
	processId?: number;
	streamId?: string;
	commandBuffer: string;
	showPrompt: boolean;
	lastCommand?: string;
	startedAt?: Date;
	abortController?: AbortController;
	// Persistence fields
	outputHistory?: string[];
	commandHistory?: string[];
	createdAt?: Date;
	lastUsedAt?: Date;
}

class TerminalSessionManager {
	private sessions = new Map<string, TerminalSessionState>();
	private activeSessionId: string | null = null;

	/**
	 * Create a new terminal session
	 */
	createSession(
		sessionId: string,
		projectId?: string,
		projectPath?: string,
		workingDirectory?: string
	): TerminalSessionState {
		const now = new Date();
		const session: TerminalSessionState = {
			id: sessionId,
			projectId,
			projectPath,
			workingDirectory: workingDirectory || projectPath || '~',
			isExecuting: false,
			commandBuffer: '',
			showPrompt: true,
			outputHistory: [],
			commandHistory: [],
			createdAt: now,
			lastUsedAt: now
		};

		this.sessions.set(sessionId, session);
		return session;
	}

	/**
	 * Get a session by ID
	 */
	getSession(sessionId: string): TerminalSessionState | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get or create a session
	 */
	getOrCreateSession(
		sessionId: string,
		projectId?: string,
		projectPath?: string,
		workingDirectory?: string
	): TerminalSessionState {
		let session = this.sessions.get(sessionId);
		if (!session) {
			session = this.createSession(sessionId, projectId, projectPath, workingDirectory);
		}
		return session;
	}

	/**
	 * Update session state
	 */
	updateSession(sessionId: string, updates: Partial<TerminalSessionState>): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			Object.assign(session, updates);
		}
	}

	/**
	 * Set active session
	 */
	setActiveSession(sessionId: string): void {
		this.activeSessionId = sessionId;
	}

	/**
	 * Get active session
	 */
	getActiveSession(): TerminalSessionState | undefined {
		if (!this.activeSessionId) return undefined;
		return this.sessions.get(this.activeSessionId);
	}

	/**
	 * Check if a session is executing
	 */
	isSessionExecuting(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session?.isExecuting || false;
	}

	/**
	 * Start command execution for a session
	 */
	startExecution(
		sessionId: string,
		command: string,
		streamId?: string,
		processId?: number
	): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.isExecuting = true;
			session.lastCommand = command;
			session.streamId = streamId;
			session.processId = processId;
			session.startedAt = new Date();
			session.showPrompt = false;
			session.commandBuffer = '';
		}
	}

	/**
	 * End command execution for a session
	 */
	endExecution(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.isExecuting = false;
			session.processId = undefined;
			session.streamId = undefined;
			session.startedAt = undefined;
			session.showPrompt = true;
			session.commandBuffer = '';

			// Clean up AbortController if exists
			if (session.abortController) {
				session.abortController.abort();
				session.abortController = undefined;
			}
		}
	}

	/**
	 * Update working directory for a session
	 */
	updateWorkingDirectory(sessionId: string, directory: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.workingDirectory = directory;
		}
	}

	/**
	 * Clean up a session
	 */
	removeSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			// Clean up any active connections
			if (session.abortController) {
				session.abortController.abort();
			}
		}
		this.sessions.delete(sessionId);

		// If this was the active session, clear it
		if (this.activeSessionId === sessionId) {
			this.activeSessionId = null;
		}
	}

	/**
	 * Get all sessions
	 */
	getAllSessions(): TerminalSessionState[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Get sessions for a specific project
	 */
	getProjectSessions(projectId: string): TerminalSessionState[] {
		return Array.from(this.sessions.values()).filter(
			session => session.projectId === projectId
		);
	}

	/**
	 * Check if any session is executing for a project
	 */
	hasExecutingSession(projectId: string): boolean {
		return this.getProjectSessions(projectId).some(session => session.isExecuting);
	}

	/**
	 * Cancel execution for a session
	 */
	cancelExecution(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session && session.isExecuting) {
			// Abort any active requests
			if (session.abortController) {
				session.abortController.abort();
			}

			// Mark as not executing
			this.endExecution(sessionId);
		}
	}

	/**
	 * Clear all sessions
	 */
	clearAll(): void {
		// Clean up all sessions properly
		for (const sessionId of this.sessions.keys()) {
			this.removeSession(sessionId);
		}
		this.sessions.clear();
		this.activeSessionId = null;
	}

	/**
	 * Store AbortController for a session
	 */
	setAbortController(sessionId: string, abortController: AbortController): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			// Clean up old AbortController if exists
			if (session.abortController) {
				session.abortController.abort();
			}
			session.abortController = abortController;
		}
	}

	/**
	 * Update command buffer for a session
	 */
	updateCommandBuffer(sessionId: string, buffer: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			session.commandBuffer = buffer;
		}
	}

	/**
	 * Get command buffer for a session
	 */
	getCommandBuffer(sessionId: string): string {
		const session = this.sessions.get(sessionId);
		return session?.commandBuffer || '';
	}

	/**
	 * Add output to session history
	 */
	addOutputToHistory(sessionId: string, output: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			if (!session.outputHistory) {
				session.outputHistory = [];
			}
			session.outputHistory.push(output);
			session.lastUsedAt = new Date();
			
			// Limit output history to prevent memory issues
			if (session.outputHistory.length > 1000) {
				session.outputHistory = session.outputHistory.slice(-1000);
			}
		}
	}

	/**
	 * Add command to session history
	 */
	addCommandToHistory(sessionId: string, command: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			if (!session.commandHistory) {
				session.commandHistory = [];
			}
			session.commandHistory.push(command);
			session.lastUsedAt = new Date();
			
			// Limit command history
			if (session.commandHistory.length > 500) {
				session.commandHistory = session.commandHistory.slice(-500);
			}
		}
	}

	/**
	 * Get session history
	 */
	getSessionHistory(sessionId: string): { outputHistory: string[]; commandHistory: string[] } {
		const session = this.sessions.get(sessionId);
		return {
			outputHistory: session?.outputHistory || [],
			commandHistory: session?.commandHistory || []
		};
	}

	/**
	 * Restore session from persistence data
	 */
	restoreSession(
		sessionId: string,
		projectId?: string,
		projectPath?: string,
		workingDirectory?: string,
		outputHistory?: string[],
		commandHistory?: string[],
		createdAt?: Date,
		lastUsedAt?: Date
	): TerminalSessionState {
		const session: TerminalSessionState = {
			id: sessionId,
			projectId,
			projectPath,
			workingDirectory: workingDirectory || projectPath || '~',
			isExecuting: false,
			commandBuffer: '',
			showPrompt: true,
			outputHistory: outputHistory || [],
			commandHistory: commandHistory || [],
			createdAt: createdAt || new Date(),
			lastUsedAt: lastUsedAt || new Date()
		};

		this.sessions.set(sessionId, session);
		return session;
	}

	/**
	 * Export sessions for persistence
	 */
	exportSessions(): TerminalSessionState[] {
		return Array.from(this.sessions.values()).map(session => ({
			...session,
			// Don't export transient fields
			abortController: undefined
		}));
	}
}

// Export singleton instance
export const terminalSessionManager = new TerminalSessionManager();

// Export type for use in other modules
export type { TerminalSessionState };