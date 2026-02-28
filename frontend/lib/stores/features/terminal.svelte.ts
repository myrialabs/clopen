/**
 * Terminal Session Store
 * Manages terminal sessions, command history, and state
 */

import type { TerminalSession, TerminalLine, TerminalCommand } from '$shared/types/terminal';
import { terminalService, type StreamingResponse } from '$frontend/lib/services/terminal';
import { addNotification } from '../ui/notification.svelte';

import { debug } from '$shared/utils/logger';
interface TerminalState {
	sessions: TerminalSession[];
	activeSessionId: string | null;
	nextSessionId: number;
	isExecuting: boolean;
	lastCommandWasCancelled: boolean;
	executingSessionIds: Set<string>; // Track multiple executing sessions
	sessionExecutionStates: Map<string, boolean>; // Track execution state per session
	lineBuffers: Map<string, string>; // Line buffering for chunked PTY output
}

// Terminal store state
const terminalState = $state<TerminalState>({
	sessions: [],
	activeSessionId: null,
	nextSessionId: 1,
	isExecuting: false,
	lastCommandWasCancelled: false,
	executingSessionIds: new Set(),
	sessionExecutionStates: new Map(),
	lineBuffers: new Map()
});

// Computed properties
export const terminalStore = {
	get sessions() { return terminalState.sessions; },
	get activeSessionId() { return terminalState.activeSessionId; },
	get isExecuting() { return terminalState.isExecuting; },
	get lastCommandWasCancelled() { return terminalState.lastCommandWasCancelled; },
	
	get activeSession() {
		return terminalState.sessions.find(session => session.id === terminalState.activeSessionId) || null;
	},

	// Get execution state for a specific session
	isSessionExecuting(sessionId: string): boolean {
		return terminalState.sessionExecutionStates.get(sessionId) || false;
	},

	// Session Management
	createNewSession(directory?: string, projectPath?: string, projectId?: string): string {
		// Terminal should only be created when there's an active project
		if (!projectId) {
			// Terminal session cannot be created without a projectId
			throw new Error('ProjectId is required to create a terminal session');
		}
		
		const sessionNumber = terminalState.nextSessionId++;
		// Always include projectId in sessionId to ensure uniqueness across projects
		const sanitizedProjectId = projectId.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8);
		const sessionId = `${sanitizedProjectId}-terminal-${sessionNumber}`;
		const sessionName = `Terminal ${sessionNumber}`;
		// Use provided directory or project path, but default to current working directory if invalid
		const workingDirectory = directory || projectPath || '~';
		
		// Check if session already exists (shouldn't happen but be safe)
		if (terminalState.sessions.find(s => s.id === sessionId)) {
			return this.createNewSession(directory, projectPath, projectId);
		}
		
		// Clear any existing buffer for this session
		terminalState.lineBuffers.delete(sessionId);

		const newSession: TerminalSession = {
			id: sessionId,
			name: sessionName,
			directory: workingDirectory,
			lines: [],
			commandHistory: [],
			isActive: true,
			createdAt: new Date(),
			lastUsedAt: new Date(),
			shellType: 'Unknown', // Will be detected later
			terminalBuffer: undefined
		};

		// Set all other sessions as inactive
		terminalState.sessions = terminalState.sessions.map(session => ({
			...session,
			isActive: false
		}));

		// Add new session
		terminalState.sessions.push(newSession);
		terminalState.activeSessionId = sessionId;

		// Detect shell type asynchronously without blocking
		// Add delay to ensure server is ready
		if (typeof window !== 'undefined') {
			setTimeout(() => {
				this.detectShellType(sessionId);
			}, 100);
		}

		return sessionId;
	},

	switchToSession(sessionId: string): void {
		// Check for duplicates before switching
		const uniqueIds = new Set<string>();
		const hasDuplicates = terminalState.sessions.some(session => {
			if (uniqueIds.has(session.id)) {
				// Duplicate session ID found
				return true;
			}
			uniqueIds.add(session.id);
			return false;
		});

		if (hasDuplicates) {
			// Remove duplicates
			const seen = new Set<string>();
			terminalState.sessions = terminalState.sessions.filter(session => {
				if (seen.has(session.id)) {
					// Removing duplicate session
					return false;
				}
				seen.add(session.id);
				return true;
			});
		}

		// Update active session
		terminalState.sessions = terminalState.sessions.map(session => ({
			...session,
			isActive: session.id === sessionId,
			lastUsedAt: session.id === sessionId ? new Date() : session.lastUsedAt
		}));

		terminalState.activeSessionId = sessionId;

		// Persist active session ID for restoration after browser refresh
		const session = terminalState.sessions.find(s => s.id === sessionId);
		if (session?.projectId && typeof sessionStorage !== 'undefined') {
			try {
				sessionStorage.setItem(`terminal-active-session-${session.projectId}`, sessionId);
			} catch {
				// sessionStorage not available
			}
		}
	},

	async closeSession(sessionId: string): Promise<boolean> {
		debug.log('terminal', `🔴 [closeSession] Starting close for session: ${sessionId}`);

		// Check if the session being closed has a running command
		const isSessionExecuting = this.isSessionExecuting(sessionId);
		debug.log('terminal', `🔴 [closeSession] Session executing: ${isSessionExecuting}`);

		// If command is running in this session, cancel it first
		if (isSessionExecuting) {
			debug.log('terminal', `🔴 [closeSession] Cancelling running command first`);

			// Store the current active session to restore later if needed
			const previousActiveSessionId = terminalState.activeSessionId;

			// Temporarily switch to the session being closed if it's not active
			if (sessionId !== terminalState.activeSessionId) {
				terminalState.activeSessionId = sessionId;
			}

			// Cancel the command
			try {
				await this.cancelCommand();
				debug.log('terminal', `🔴 [closeSession] Command cancelled successfully`);
			} catch (error) {
				debug.error('terminal', `🔴 [closeSession] Error cancelling command:`, error);
			}

			// Restore the previous active session if we temporarily switched
			if (sessionId !== previousActiveSessionId && previousActiveSessionId) {
				terminalState.activeSessionId = previousActiveSessionId;
			}
		}

		// CRITICAL: Kill PTY session on server
		debug.log('terminal', `🔴 [closeSession] Attempting to kill PTY session on server...`);
		try {
			const killed = await terminalService.killSession(sessionId);
			debug.log('terminal', `🔴 [closeSession] Kill PTY response:`, { success: killed });
		} catch (error) {
			debug.error('terminal', `🔴 [closeSession] Failed to kill PTY session:`, error);
		}

		// Clear persistence data for this session
		debug.log('terminal', `🔴 [closeSession] Clearing persistence data...`);
		try {
			const { terminalPersistenceManager } = await import('$frontend/lib/services/terminal/persistence.service');
			// Remove entire session from persistence (not just stream info)
			terminalPersistenceManager.removeSession(sessionId);
			debug.log('terminal', `🔴 [closeSession] Persistence data cleared`);
		} catch (error) {
			debug.error('terminal', `🔴 [closeSession] Failed to clear persistence:`, error);
		}

		// CRITICAL: Also remove from terminalProjectManager context
		// This prevents session from being recreated on browser refresh
		debug.log('terminal', `🔴 [closeSession] Removing from project context...`);
		try {
			const { terminalProjectManager } = await import('$frontend/lib/services/terminal/project.service');
			terminalProjectManager.removeSessionFromContext(sessionId);
			debug.log('terminal', `🔴 [closeSession] Removed from project context`);
		} catch (error) {
			debug.error('terminal', `🔴 [closeSession] Failed to remove from project context:`, error);
		}

		// Clear any buffered content for this session
		terminalState.lineBuffers.delete(sessionId);

		// Remove execution states for this session
		terminalState.sessionExecutionStates.delete(sessionId);
		terminalState.executingSessionIds.delete(sessionId);

		terminalState.sessions = terminalState.sessions.filter(session => session.id !== sessionId);
		debug.log('terminal', `🔴 [closeSession] Session removed from state. Remaining sessions: ${terminalState.sessions.length}`);

		// If we closed the active session, switch to another one (if available)
		if (sessionId === terminalState.activeSessionId) {
			const newActiveSession = terminalState.sessions[0];
			if (newActiveSession) {
				debug.log('terminal', `🔴 [closeSession] Switching to session: ${newActiveSession.id}`);
				this.switchToSession(newActiveSession.id);
			}
		}

		debug.log('terminal', `🔴 [closeSession] Close completed for session: ${sessionId}`);
		return true;
	},

	// Update session directory (used when working directory changes)
	updateSessionDirectory(sessionId: string, newDirectory: string): void {
		const session = terminalState.sessions.find(s => s.id === sessionId);
		if (session) {
			// Update the session's current directory
			session.directory = newDirectory;
			
			// DO NOT update historical input lines - they should preserve their original directory
			// Historical prompts should show the directory at the time the command was executed
		}
	},

	// Connect to PTY session (for initial auto-connect)
	async connectToSession(projectPath?: string, projectId?: string, terminalSize?: { cols: number; rows: number }): Promise<void> {
		const activeSession = this.activeSession;
		if (!activeSession) {
			return;
		}

		// Connect to PTY session via SSE
		try {
			await terminalService.connectToSession(
				{
					sessionId: activeSession.id,
					workingDirectory: activeSession.directory,
					projectPath,
					projectId,
					terminalSize
				},
				(data: StreamingResponse) => this.handleStreamingData(activeSession.id, data)
			);
		} catch (error) {
			// Silently handle connection errors
		}
	},

	async cancelCommand(): Promise<void> {
		const activeSession = this.activeSession;
		if (!activeSession) {
			return;
		}

		// Always send Ctrl+C signal regardless of execution state
		// This provides a utility shortcut for mobile accessibility
		const wasExecuting = this.isSessionExecuting(activeSession.id);

		// Flush any buffered content before cancel (if was executing)
		if (wasExecuting) {
			const remainingBuffer = terminalState.lineBuffers.get(activeSession.id);
			if (remainingBuffer && remainingBuffer.length > 0) {
				this.addLineToSession(activeSession.id, {
					content: remainingBuffer,
					type: 'output',
					timestamp: new Date()
				});
				terminalState.lineBuffers.set(activeSession.id, '');
			}

			// Mark that we're attempting to cancel
			terminalState.lastCommandWasCancelled = true;

			// Add ^C message to terminal with proper newline
			this.addLineToSession(activeSession.id, {
				content: '^C\r\n',
				type: 'error',
				timestamp: new Date()
			});
		}

		try {
			const success = await terminalService.cancelCommand(activeSession.id);

			// Clear the restoration flag regardless of success (if was executing)
			if (wasExecuting && typeof window !== 'undefined') {
				sessionStorage.removeItem('terminal-restored-' + activeSession.id);
			}

			// Stop execution state and show prompt after cancel attempt (if was executing)
			if (wasExecuting) {
				terminalState.sessionExecutionStates.set(activeSession.id, false);
				terminalState.executingSessionIds.delete(activeSession.id);

				// Update global state only if active session
				if (activeSession.id === terminalState.activeSessionId) {
					terminalState.isExecuting = false;
				}

				// Show prompt after a short delay
				setTimeout(() => {
					this.triggerPromptDisplay(activeSession.id);
				}, 200);
			}

		} catch (error) {
			// Only log error to console, don't show to user
			debug.error('terminal', 'Terminal cancel error:', error);

			// Even on error, stop execution state (if was executing)
			if (wasExecuting) {
				terminalState.sessionExecutionStates.set(activeSession.id, false);
				terminalState.executingSessionIds.delete(activeSession.id);

				if (activeSession.id === terminalState.activeSessionId) {
					terminalState.isExecuting = false;
				}

				// Still trigger prompt even on error
				setTimeout(() => {
					this.triggerPromptDisplay(activeSession.id);
				}, 200);
			}
		}
	},

	// Process buffered output to handle chunked PTY data properly
	processBufferedOutput(sessionId: string, content: string, type: 'output' | 'error'): void {
		// Buffer incomplete lines to avoid splitting words like "Reply" into "R" and "eply"
		let buffer = terminalState.lineBuffers.get(sessionId) || '';
		buffer += content;
		
		// Only send complete chunks to avoid word splitting
		// If buffer ends with a partial ANSI sequence or in middle of a word, wait for more
		if (buffer.length < 2) {
			// Very short buffer, likely incomplete - wait for more
			terminalState.lineBuffers.set(sessionId, buffer);
			return;
		}
		
		// Check if we're in the middle of an ANSI escape sequence
		const lastEscIndex = buffer.lastIndexOf('\x1b');
		if (lastEscIndex >= 0 && lastEscIndex > buffer.length - 10) {
			// Might be in middle of escape sequence, check if it's complete
			const remaining = buffer.substring(lastEscIndex);
			if (!/^(\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9]+[lh])/.test(remaining)) {
				// Incomplete escape sequence, wait for more
				terminalState.lineBuffers.set(sessionId, buffer);
				return;
			}
		}
		
		// Send the buffer and clear it
		if (buffer.length > 0) {
			this.addLineToSession(sessionId, {
				content: buffer,
				type: type,
				timestamp: new Date()
			});
			terminalState.lineBuffers.set(sessionId, '');
		}
	},

	// Session Content Management
	addLineToSession(sessionId: string, line: TerminalLine): void {
		terminalState.sessions = terminalState.sessions.map(session => 
			session.id === sessionId 
				? { 
					...session, 
					lines: [...session.lines, line],
					lastUsedAt: new Date()
				}
				: session
		);
	},

	updateSessionHistory(sessionId: string, history: string[]): void {
		terminalState.sessions = terminalState.sessions.map(session => 
			session.id === sessionId 
				? { ...session, commandHistory: history }
				: session
		);
	},


	clearSession(sessionId: string): void {
		// Clear any buffered content for this session
		terminalState.lineBuffers.delete(sessionId);
		
		// CRITICAL FIX: Actually clear the session lines history
		// This ensures when switching tabs, the cleared terminal stays clear
		terminalState.sessions = terminalState.sessions.map(session => 
			session.id === sessionId 
				? { 
					...session, 
					lines: [], // Clear all lines history
					// Keep command history intact (user might want to access previous commands)
					commandHistory: session.commandHistory,
					// Clear terminal buffer as well
					terminalBuffer: undefined
				}
				: session
		);
		
		// Add a special "clear" marker line to trigger visual clear
		// This tells the XTerm component to clear the visual display
		const clearLine: TerminalLine = {
			content: '',
			type: 'clear-screen', // Now properly typed in TerminalLine interface
			timestamp: new Date()
		};
		
		// Then add the clear marker
		terminalState.sessions = terminalState.sessions.map(session => 
			session.id === sessionId 
				? { 
					...session, 
					lines: [clearLine] // Start fresh with just the clear marker
				}
				: session
		);
	},

	// Handle streaming data from terminal service
	handleStreamingData(sessionId: string, data: StreamingResponse): void {
		switch (data.type) {
			case 'clear-screen':
				// Handle clear screen command
				this.clearSession(sessionId);
				// Trigger prompt display after clear
				setTimeout(() => {
					this.triggerPromptDisplay(sessionId);
				}, 100);
				break;
				
			case 'output':
				if (data.content) {
					// Use line buffering for output to handle chunked PTY data
					this.processBufferedOutput(sessionId, data.content, 'output');
				}
				break;

			case 'error':
				if (data.content) {
					// Error messages are usually complete, but still buffer for safety
					this.processBufferedOutput(sessionId, data.content, 'error');
				}
				break;

			case 'directory':
				if (data.newDirectory) {
					// Update session directory
					this.updateSessionDirectory(sessionId, data.newDirectory);
				}
				break;

			case 'exit':
				// Flush any remaining buffer content
				const remainingBuffer = terminalState.lineBuffers.get(sessionId);
				if (remainingBuffer && remainingBuffer.length > 0) {
					this.addLineToSession(sessionId, {
						content: remainingBuffer,
						type: 'output',
						timestamp: new Date()
					});
					terminalState.lineBuffers.set(sessionId, '');
				}
				
				// Check if command was cancelled
				if (data.content?.includes('interrupted')) {
					terminalState.lastCommandWasCancelled = true;
				}
				// Add prompt trigger after command exits
				this.addLineToSession(sessionId, {
					content: '',
					type: 'prompt-trigger',
					timestamp: new Date()
				});
				break;

			case 'complete':
				// Remove session from executing set
				terminalState.executingSessionIds.delete(sessionId);
				terminalState.sessionExecutionStates.set(sessionId, false);
				// Update global executing state only if it's the active session
				if (sessionId === terminalState.activeSessionId) {
					terminalState.isExecuting = false;
				}
				// Always trigger prompt display for the completed session
				this.triggerPromptDisplay(sessionId);
				break;
		}
	},

	// Detect shell type for a session
	async detectShellType(sessionId: string): Promise<void> {
		// Skip detection if we're in SSR
		if (typeof window === 'undefined') {
			return;
		}
		
		try {
			// Check shell availability via WebSocket
			const data = await terminalService.checkShellAvailability();

			if (data.available) {
				const shellType = data.shellType || 'Unknown';

				// Update session with detected shell type
				const session = terminalState.sessions.find(s => s.id === sessionId);
				if (session) {
					session.shellType = shellType;
				}
			} else {
				throw new Error('Shell not available');
			}
		} catch (error) {
			// Silently fallback to default - don't spam console
			const defaultShellType = navigator.platform.includes('Win') 
				? 'PowerShell' 
				: 'Bash';
			
			const session = terminalState.sessions.find(s => s.id === sessionId);
			if (session) {
				session.shellType = defaultShellType;
			}
		}
	},

	// Helper methods for background service
	getSession(sessionId: string): TerminalSession | undefined {
		return terminalState.sessions.find(s => s.id === sessionId);
	},
	
	updateNextSessionId(nextId: number): void {
		if (nextId > terminalState.nextSessionId) {
			terminalState.nextSessionId = nextId;
			// Updated nextSessionId to avoid conflicts
		}
	},
	
	addSession(session: TerminalSession): void {
		// Check if session already exists to prevent duplicates
		const existingSession = terminalState.sessions.find(s => s.id === session.id);
		if (existingSession) {
			return;
		}
		terminalState.sessions.push(session);
		
		// Update nextSessionId to be higher than any existing session ID
		const match = session.id.match(/terminal-(\d+)/);
		if (match) {
			const sessionNumber = parseInt(match[1], 10);
			if (sessionNumber >= terminalState.nextSessionId) {
				terminalState.nextSessionId = sessionNumber + 1;
			}
		}
	},
	
	setActiveSession(sessionId: string): void {
		this.switchToSession(sessionId);
	},

	/**
	 * Remove a session from store without killing PTY (used for collaborative sync).
	 * When another user closes a tab, we only need to remove it from our UI.
	 */
	removeSessionFromStore(sessionId: string): void {
		terminalState.lineBuffers.delete(sessionId);
		terminalState.sessionExecutionStates.delete(sessionId);
		terminalState.executingSessionIds.delete(sessionId);
		terminalState.sessions = terminalState.sessions.filter(s => s.id !== sessionId);

		// Switch to another session if this was active
		if (terminalState.activeSessionId === sessionId) {
			const newActive = terminalState.sessions[0];
			if (newActive) {
				this.switchToSession(newActive.id);
			} else {
				terminalState.activeSessionId = null;
			}
		}
	},
	
	addOutput(sessionId: string, line: TerminalLine): void {
		this.addLineToSession(sessionId, line);
	},
	
	setExecutingState(sessionId: string, isExecuting: boolean): void {
		// Update both Maps to ensure consistency
		if (isExecuting) {
			terminalState.executingSessionIds.add(sessionId);
			terminalState.sessionExecutionStates.set(sessionId, true);
		} else {
			terminalState.executingSessionIds.delete(sessionId);
			terminalState.sessionExecutionStates.set(sessionId, false);
		}
		
		// Update global executing state based on active session
		if (sessionId === terminalState.activeSessionId) {
			terminalState.isExecuting = isExecuting;
		}
		
		// setExecutingState for session
	},
	
	updateWorkingDirectory(sessionId: string, newDirectory: string): void {
		this.updateSessionDirectory(sessionId, newDirectory);
	},
	
	triggerPromptDisplay(sessionId: string): void {
		// This method is called when terminal needs to show prompt after restoration
		// Add a special line to trigger prompt display in XTerm
		const session = this.getSession(sessionId);
		if (session) {
			const promptTriggerLine: TerminalLine = {
				type: 'prompt-trigger',
				content: '',
				timestamp: new Date()
			};
			terminalState.sessions = terminalState.sessions.map(s => 
				s.id === sessionId 
					? { ...s, lines: [...s.lines, promptTriggerLine] }
					: s
			);
		}
	},
	
	// Initialize terminal store
	// Save terminal buffer state for a session
	saveTerminalBuffer(sessionId: string, buffer: import('$shared/types/terminal').TerminalBuffer): void {
		const session = terminalState.sessions.find(s => s.id === sessionId);
		if (session) {
			session.terminalBuffer = buffer;
		}
	},
	
	// Get terminal buffer for a session
	getTerminalBuffer(sessionId: string): import('$shared/types/terminal').TerminalBuffer | undefined {
		const session = terminalState.sessions.find(s => s.id === sessionId);
		return session?.terminalBuffer;
	},
	
	initialize(hasActiveProject: boolean, projectPath?: string): void {
		// If there's an active project, let terminalProjectManager handle session creation
		// Otherwise, create a default session for non-project use
		if (terminalState.sessions.length === 0) {
			if (hasActiveProject) {
				// Don't create session here - terminalProjectManager will handle it
				// Active project detected, waiting for terminalProjectManager to create sessions
			} else {
				// No active project - terminal should not be accessible
				// No active project, terminal not available
				// Don't create any session - UI should show "No Active Project" message
			}
		} else {
			// Found existing sessions
		}
	},

	// Note: Shell availability is now checked on-demand in the server
	// PowerShell on Windows, Bash on Unix systems
	
	/**
	 * Clear all terminal sessions and related data
	 * Used when Clear All Data is triggered
	 */
	clearAllSessions(): void {
		// Clear terminal state
		terminalState.sessions = [];
		terminalState.activeSessionId = null;
		terminalState.nextSessionId = 1;
		terminalState.isExecuting = false;
		terminalState.lastCommandWasCancelled = false;
		terminalState.executingSessionIds.clear();
		terminalState.sessionExecutionStates.clear();
		terminalState.lineBuffers.clear();

		// Clear terminal persistence data (in-memory)
		import('$frontend/lib/services/terminal/persistence.service').then(({ terminalPersistenceManager }) => {
			terminalPersistenceManager.clearAll();
		});
	}
};