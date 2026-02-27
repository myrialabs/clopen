/**
 * Terminal Project Manager
 * Manages terminal sessions per project with automatic context switching
 */

import { terminalSessionManager, type TerminalSessionState } from './session.service';
import { terminalPersistenceManager } from './persistence.service';
import { terminalStore } from '$frontend/lib/stores/features/terminal.svelte';
import type { TerminalSession } from '$shared/types/terminal';
import { terminalService } from './terminal.service';
import { debug } from '$shared/utils/logger';
interface ProjectTerminalContext {
	projectId: string;
	projectPath: string;
	sessionIds: string[];
	activeSessionId: string | null;
	lastActiveAt: Date;
	// Store terminal output per session for this project
	sessionOutputs: Map<string, Array<{ content: string; type: string; timestamp: Date }>>;
	// Store command history per session for this project
	sessionCommandHistories: Map<string, string[]>;
}

class TerminalProjectManager {
	private projectContexts = new Map<string, ProjectTerminalContext>();
	private currentProjectId: string | null = null;

	constructor() {
		// Initialize will be called from outside to set up event listeners
	}

	/**
	 * Initialize or get terminal context for a project
	 */
	getOrCreateProjectContext(projectId: string, projectPath: string): ProjectTerminalContext {
		let context = this.projectContexts.get(projectId);
		
		if (!context) {
			context = {
				projectId,
				projectPath,
				sessionIds: [],
				activeSessionId: null,
				lastActiveAt: new Date(),
				sessionOutputs: new Map(),
				sessionCommandHistories: new Map()
			};
			this.projectContexts.set(projectId, context);
			this.persistContexts();
		}
		
		return context;
	}

	/**
	 * Switch to a different project's terminal context
	 */
	async switchToProject(projectId: string, projectPath: string): Promise<void> {
		// Switching to project

		// Save current project's terminal state if switching away
		if (this.currentProjectId && this.currentProjectId !== projectId) {
			await this.saveCurrentProjectState();
			// Hide current project's terminal sessions (but keep them running)
			await this.hideProjectTerminalSessions(this.currentProjectId);

			// Background output collection is handled by the server
		}

		// Get or create context for the new project
		const context = this.getOrCreateProjectContext(projectId, projectPath);

		// Context for project

		// Clear any existing sessions in store to prevent cross-contamination
		if (this.currentProjectId !== projectId) {
			// Clear all sessions properly
			terminalStore.clearAllSessions();
		}

		// Restore or create terminal sessions for this project
		if (context.sessionIds.length === 0) {
			// No sessions for project, creating initial session
			await this.createProjectTerminalSessions(projectId, projectPath);
		} else {
			// Show existing terminal sessions for this project
			await this.showProjectTerminalSessions(context);
		}

		// Update current project
		this.currentProjectId = projectId;
		context.lastActiveAt = new Date();
		this.persistContexts();

		// Check for active streams for this project after switching
		await this.checkAndRestoreActiveStreams(projectId);
	}

	/**
	 * Create initial terminal sessions for a project
	 */
	private async createProjectTerminalSessions(projectId: string, projectPath: string): Promise<void> {
		// Creating terminal session for project
		
		const context = this.getOrCreateProjectContext(projectId, projectPath);
		
		// Create only 1 terminal session by default with correct project path and projectId
		const sessionId = terminalStore.createNewSession(projectPath, projectPath, projectId);
		
		// Update the session's directory to ensure it's correct
		const session = terminalStore.getSession(sessionId);
		if (session) {
			session.directory = projectPath;
		}
		
		// Create a fresh session in terminalSessionManager with correct project association
		terminalSessionManager.createSession(sessionId, projectId, projectPath, projectPath);
		
		context.sessionIds.push(sessionId);
		context.activeSessionId = sessionId;
		terminalStore.switchToSession(sessionId);
		
		this.persistContexts();
	}

	/**
	 * Hide terminal sessions for a project (keep them running in background)
	 */
	private async hideProjectTerminalSessions(projectId: string): Promise<void> {
		const context = this.projectContexts.get(projectId);
		if (!context) return;

		// Hiding sessions for project

		// Save execution state before hiding (in-memory via persistence manager)
		for (const sessionId of context.sessionIds) {
			const session = terminalSessionManager.getSession(sessionId);
			if (session && session.isExecuting && session.streamId) {
				terminalPersistenceManager.saveActiveStream(
					sessionId, session.streamId, session.lastCommand || '', projectId
				);
			}
		}

		// CRITICAL: Clean up WebSocket listeners for ALL sessions in this project
		// This prevents stale listeners from accumulating when switching projects
		// which would cause duplicate terminal output processing (input duplication bug)
		for (const sessionId of context.sessionIds) {
			terminalService.cleanupListeners(sessionId);
		}

		// Clear the terminal store to hide sessions from UI
		// Sessions are preserved in terminalSessionManager
		terminalStore.clearAllSessions();
	}
	
	/**
	 * Show terminal sessions for a project
	 */
	private async showProjectTerminalSessions(context: ProjectTerminalContext): Promise<void> {
		// Showing sessions for project

		// Clear all sessions from store first to ensure clean slate
		terminalStore.clearAllSessions();

		// Import terminalPersistenceManager to check for active streams
		const { terminalPersistenceManager } = await import('./persistence.service');
		const allActiveStreams = terminalPersistenceManager.getAllActiveStreams();

		// Restore all sessions for this project from saved state
		if (context.sessionIds.length > 0) {
			for (const sessionId of context.sessionIds) {
				// Create a new terminal session in the store
				// Extract terminal number from sessionId (format: projectId-terminal-N or terminal-N)
				const sessionParts = sessionId.split('-');
				const terminalNumber = sessionParts[sessionParts.length - 1] || '1';

				const terminalSession: TerminalSession = {
					id: sessionId,
					name: `Terminal ${terminalNumber}`,
					directory: context.projectPath, // Always use the project path as base directory
					lines: [],
					commandHistory: [],
					isActive: false,
					createdAt: new Date(),
					lastUsedAt: new Date(),
					shellType: 'Unknown',
					terminalBuffer: undefined,
					projectId: context.projectId,
					projectPath: context.projectPath
				};

				// Check for active streams for this session first (before restoring output)
				let hasActiveStream = false;
				let activeStreamInfo: any = null;
				for (const stream of allActiveStreams) {
					// Match by projectId and terminal number
					if (stream.projectId === context.projectId) {
						// Extract terminal number from stream sessionId
						const streamParts = stream.sessionId.split('-');
						const streamTerminalNumber = streamParts[streamParts.length - 1];
						if (streamTerminalNumber === terminalNumber) {
							hasActiveStream = true;
							activeStreamInfo = stream;
							break;
						}
					}
				}

				// Restore saved output for this session
				let baseOutput: any[] = [];
				let backgroundOutput: any[] = [];

				// First, restore base output from context (input/output sebelumnya)
				if (context.sessionOutputs.has(sessionId)) {
					const savedOutput = context.sessionOutputs.get(sessionId);
					if (savedOutput) {
						baseOutput = savedOutput.map(output => ({
							content: output.content,
							type: output.type as any,
							timestamp: output.timestamp
						}));
						// Restored base output lines for session
					}
				}

				// Second, get NEW output from server that was generated while we were away
				// We need to track when we saved the output to know what's new
				if (hasActiveStream && activeStreamInfo) {
					try {
						// Get the saved output count from context metadata
						// This tells us how much output we had when we switched away
						let savedOutputCount = 0;
						const savedMetadata = context.sessionOutputs.get(`${sessionId}-metadata`);
						if (savedMetadata && typeof savedMetadata === 'object' && 'outputCount' in savedMetadata) {
							savedOutputCount = (savedMetadata as any).outputCount || 0;
						} else {
							// Fallback: count actual output lines in baseOutput
							for (const line of baseOutput) {
								if (line.type === 'output' || line.type === 'error') {
									savedOutputCount++;
								}
							}
						}

						// Get only NEW output from server (skip what we already have)
						const data = await terminalService.getMissedOutput(
							sessionId,
							activeStreamInfo.streamId,
							savedOutputCount
						);
						if (data.success && data.output && data.output.length > 0) {
							// Convert server output to terminal lines
							backgroundOutput = data.output.map((content: string) => ({
								content: content,
								type: 'output',
								timestamp: new Date()
							}));
							debug.log('terminal', `Restored ${backgroundOutput.length} new output lines for session ${sessionId}`);
						}
					} catch (error) {
						debug.error('terminal', 'Failed to fetch missed output:', error);
					}
				}

				// Combine base output with background output from server
				// Base output contains previous input/output saved in context
				// Background output contains new output from server (if any)
				terminalSession.lines = [...baseOutput, ...backgroundOutput];

				// Restore command history from context (persisted) rather than manager (temporary)
				const savedCommandHistory = context.sessionCommandHistories.get(sessionId);
				if (savedCommandHistory) {
					terminalSession.commandHistory = savedCommandHistory;
					// Restored command history items for session
				}

				// Check if session exists in manager for execution state
				const managerSession = terminalSessionManager.getSession(sessionId);
				if (managerSession) {
					// Update manager's command history with persisted history
					if (savedCommandHistory) {
						managerSession.commandHistory = savedCommandHistory;
					}
					// Always use project path for directory when switching projects
					// This ensures the visual directory is correct
					terminalSession.directory = context.projectPath;

					// IMPORTANT: Restore execution state to fix interrupt button visibility
					// When switching back to a project with running processes, the execution
					// state must be preserved for the interrupt button to show correctly
					if (hasActiveStream || managerSession.isExecuting) {
						// Restoring execution state for session
						// Update the store's execution state for this session
						terminalStore.setExecutingState(sessionId, true);

						// Update manager session with stream info if available
						if (activeStreamInfo) {
							managerSession.isExecuting = true;
							managerSession.streamId = activeStreamInfo.streamId;
							managerSession.lastCommand = activeStreamInfo.command;
						}
					}
				}

				// Add session to store
				terminalStore.addSession(terminalSession);

				// Ensure session exists in manager with correct project association and directory
				if (!managerSession || managerSession.projectId !== context.projectId) {
					const newSession = terminalSessionManager.createSession(sessionId, context.projectId, context.projectPath, context.projectPath);
					// If we have active stream info, update the new session
					if (hasActiveStream && activeStreamInfo) {
						newSession.isExecuting = true;
						newSession.streamId = activeStreamInfo.streamId;
						newSession.lastCommand = activeStreamInfo.command;
					}
				} else {
					// Update existing session to ensure correct directory
					terminalSessionManager.updateSession(sessionId, {
						projectId: context.projectId,
						projectPath: context.projectPath,
						workingDirectory: context.projectPath
					});
				}
			}
		} else {
			// No sessions exist, create a new one
			// No sessions for project, creating new
			const newSessionId = terminalStore.createNewSession(context.projectPath, context.projectPath, context.projectId);

			// Create in manager
			terminalSessionManager.createSession(newSessionId, context.projectId, context.projectPath, context.projectPath);

			context.sessionIds.push(newSessionId);
			context.activeSessionId = newSessionId;
		}

		// Switch to the active session for this project
		if (context.activeSessionId && context.sessionIds.includes(context.activeSessionId)) {
			terminalStore.switchToSession(context.activeSessionId);
		} else if (context.sessionIds.length > 0) {
			// Active session is invalid, use first available
			context.activeSessionId = context.sessionIds[0];
			terminalStore.switchToSession(context.activeSessionId);
		}

		this.persistContexts();
	}

	/**
	 * Restore terminal sessions for a project (deprecated - use showProjectTerminalSessions)
	 */
	private async restoreProjectTerminalSessions(context: ProjectTerminalContext): Promise<void> {
		// Restoring sessions for project
		
		// Show sessions for this project
		for (const sessionId of context.sessionIds) {
			const storeSession = terminalStore.getSession(sessionId);
			const managerSession = terminalSessionManager.getSession(sessionId);
			
			if (storeSession) {
				// Session exists in store, just make it visible
				// Session already exists, making visible
			} else if (managerSession) {
				// Session exists in manager but not in store, restore it
				// Restoring session from manager
				this.restoreSessionToStore(managerSession);
			} else {
				// Session doesn't exist, create a new one
				// Session not found, creating new
				const newSessionId = terminalStore.createNewSession(context.projectPath, context.projectPath, context.projectId);
				
				// Update context with new session ID
				const index = context.sessionIds.indexOf(sessionId);
				if (index !== -1) {
					context.sessionIds[index] = newSessionId;
				}
				
				// Link to project
				terminalSessionManager.updateSession(newSessionId, {
					projectId: context.projectId,
					projectPath: context.projectPath
				});
				
				// Update active session ID if needed
				if (context.activeSessionId === sessionId) {
					context.activeSessionId = newSessionId;
				}
			}
		}
		
		// Switch to the active session for this project
		if (context.activeSessionId) {
			terminalStore.switchToSession(context.activeSessionId);
		} else if (context.sessionIds.length > 0) {
			// No active session, use the first one
			context.activeSessionId = context.sessionIds[0];
			terminalStore.switchToSession(context.activeSessionId);
		}
	}

	/**
	 * Restore a session from manager to store with project-specific output
	 */
	private restoreSessionToStore(managerSession: TerminalSessionState, projectContext?: ProjectTerminalContext): void {
		// Ensure the working directory is correct for this project
		const correctDirectory = managerSession.projectPath || managerSession.workingDirectory;
		
		// Extract terminal number from sessionId (format: projectId-terminal-N or terminal-N)
		const sessionParts = managerSession.id.split('-');
		const terminalNumber = sessionParts[sessionParts.length - 1] || '1';
		
		const terminalSession: TerminalSession = {
			id: managerSession.id,
			name: `Terminal ${terminalNumber}`,
			directory: correctDirectory,
			lines: [],
			commandHistory: managerSession.commandHistory || [],
			isActive: false,
			createdAt: managerSession.createdAt || new Date(),
			lastUsedAt: managerSession.lastUsedAt || new Date(),
			shellType: 'Unknown',
			terminalBuffer: undefined,
			projectId: managerSession.projectId,
			projectPath: managerSession.projectPath
		};
		
		// Restore output lines from project context if available
		if (projectContext && projectContext.sessionOutputs.has(managerSession.id)) {
			const savedOutput = projectContext.sessionOutputs.get(managerSession.id);
			if (savedOutput) {
				terminalSession.lines = savedOutput.map(output => ({
					content: output.content,
					type: output.type as any,
					timestamp: output.timestamp
				}));
				// Restored lines for session
			}
		}
		
		terminalStore.addSession(terminalSession);
	}


	/**
	 * Save current project's terminal state
	 */
	private async saveCurrentProjectState(): Promise<void> {
		if (!this.currentProjectId) return;
		
		const context = this.projectContexts.get(this.currentProjectId);
		if (!context) return;
		
		// Saving state for project
		
		// Update active session ID
		const activeSessionId = terminalStore.activeSessionId;
		if (activeSessionId) {
			context.activeSessionId = activeSessionId;
		}
		
		// Save session outputs and states
		for (const sessionId of context.sessionIds) {
			const session = terminalStore.getSession(sessionId);
			if (session) {
				// Save output lines for this specific project session
				const outputLines = session.lines.map(line => ({
					content: line.content,
					type: line.type,
					timestamp: line.timestamp || new Date()
				}));
				context.sessionOutputs.set(sessionId, outputLines);

				// Save metadata about how many output lines we have
				// This helps us know what's new when we come back
				let outputCount = 0;
				for (const line of session.lines) {
					if (line.type === 'output' || line.type === 'error') {
						outputCount++;
					}
				}
				context.sessionOutputs.set(`${sessionId}-metadata`, { outputCount } as any);
				
				// Save command history for this specific project session
				if (session.commandHistory && session.commandHistory.length > 0) {
					context.sessionCommandHistories.set(sessionId, session.commandHistory);
					// Saved command history items for session
				}
				
				// Update session metadata in manager
				terminalSessionManager.updateSession(sessionId, {
					commandHistory: session.commandHistory,
					workingDirectory: session.directory,
					projectId: this.currentProjectId,
					projectPath: context.projectPath
				});
			}
		}
		
		this.persistContexts();
	}

	/**
	 * Save all projects' terminal states (called before browser unload)
	 */
	saveAllProjectStates(): void {
		// Saving all project states before unload
		
		// Save current project state first
		if (this.currentProjectId) {
			this.saveCurrentProjectState();
		}
		
		// Save command history from terminalSessionManager for all projects
		for (const [projectId, context] of this.projectContexts.entries()) {
			if (projectId === this.currentProjectId) {
				// Already saved above
				continue;
			}
			
			// Saving state for background project
			
			// Update command history from session manager for all sessions
			for (const sessionId of context.sessionIds) {
				const managerSession = terminalSessionManager.getSession(sessionId);
				if (managerSession && managerSession.commandHistory) {
					// Save command history from manager
					context.sessionCommandHistories.set(sessionId, managerSession.commandHistory);
					// Saved command history items for background session
				}
			}
		}
		
		// Sync stream info to persistence manager
		this.persistContexts();
	}

	/**
	 * Add a new terminal session to the current project
	 */
	addTerminalToCurrentProject(forceProjectId?: string, forceProjectPath?: string): string | null {
		// Use forced project ID if provided (for cases where currentProjectId isn't set yet)
		const projectIdToUse = forceProjectId || this.currentProjectId;
		if (!projectIdToUse) {
			// Cannot add terminal: no project ID available
			return null;
		}
		
		// Get or create context
		let context = this.projectContexts.get(projectIdToUse);
		if (!context && forceProjectPath) {
			// Create context if it doesn't exist and we have a path
			context = this.getOrCreateProjectContext(projectIdToUse, forceProjectPath);
		}
		if (!context) {
			// Cannot add terminal: no context for project
			return null;
		}
		
		// Update current project ID if we're forcing it
		if (forceProjectId && forceProjectId !== this.currentProjectId) {
			this.currentProjectId = forceProjectId;
		}
		
		// Adding new terminal to project
		
		// Create new session with correct project path and projectId for proper isolation
		const sessionId = terminalStore.createNewSession(context.projectPath, context.projectPath, projectIdToUse);
		
		// Ensure the directory is set correctly
		const session = terminalStore.getSession(sessionId);
		if (session) {
			session.directory = context.projectPath;
		}
		
		// Create corresponding session in manager with correct project association
		terminalSessionManager.createSession(sessionId, projectIdToUse, context.projectPath, context.projectPath);
		
		// Add to context
		context.sessionIds.push(sessionId);
		context.activeSessionId = sessionId;
		this.persistContexts();
		
		return sessionId;
	}

	/**
	 * Remove a terminal session from the current project
	 */
	async removeTerminalFromCurrentProject(sessionId: string): Promise<boolean> {
		if (!this.currentProjectId) return false;

		const context = this.projectContexts.get(this.currentProjectId);
		if (!context) return false;

		// Don't allow removing the last terminal
		if (context.sessionIds.length <= 1) return false;

		// Remove from context
		context.sessionIds = context.sessionIds.filter(id => id !== sessionId);

		// Update active session if needed
		if (context.activeSessionId === sessionId && context.sessionIds.length > 0) {
			context.activeSessionId = context.sessionIds[0];
		}

		// Remove from stores
		await terminalStore.closeSession(sessionId);
		terminalSessionManager.removeSession(sessionId);

		this.persistContexts();
		return true;
	}

	/**
	 * Remove a session from project context (called when terminal tab is closed)
	 * This is different from removeTerminalFromCurrentProject - it doesn't call closeSession
	 * to avoid circular dependency
	 */
	removeSessionFromContext(sessionId: string): void {
		debug.log('terminal', `🗑️ [projectManager] Removing session from context: ${sessionId}`);

		// Find which project this session belongs to
		for (const [projectId, context] of this.projectContexts.entries()) {
			const sessionIndex = context.sessionIds.indexOf(sessionId);
			if (sessionIndex !== -1) {
				debug.log('terminal', `🗑️ [projectManager] Found session in project: ${projectId}`);
				debug.log('terminal', `🗑️ [projectManager] Sessions before: ${context.sessionIds.join(', ')}`);

				// Remove from sessionIds array
				context.sessionIds.splice(sessionIndex, 1);

				// Clear session-related data
				context.sessionOutputs.delete(sessionId);
				context.sessionOutputs.delete(`${sessionId}-metadata`);
				context.sessionCommandHistories.delete(sessionId);

				// Update active session if needed
				if (context.activeSessionId === sessionId) {
					context.activeSessionId = context.sessionIds[0] || null;
					debug.log('terminal', `🗑️ [projectManager] Updated activeSessionId to: ${context.activeSessionId}`);
				}

				debug.log('terminal', `🗑️ [projectManager] Sessions after: ${context.sessionIds.join(', ')}`);

				// Also remove from terminalSessionManager
				terminalSessionManager.removeSession(sessionId);

				// Persist changes
				this.persistContexts();
				debug.log('terminal', `🗑️ [projectManager] Context persisted`);
				return;
			}
		}

		debug.log('terminal', `🗑️ [projectManager] Session not found in any project context`);
	}

	/**
	 * Get terminal sessions for a specific project
	 */
	getProjectSessions(projectId: string): string[] {
		const context = this.projectContexts.get(projectId);
		return context?.sessionIds || [];
	}

	/**
	 * Check if a project has running terminal sessions
	 */
	hasRunningTerminals(projectId: string): boolean {
		const context = this.projectContexts.get(projectId);
		if (!context) return false;
		
		return context.sessionIds.some(sessionId => {
			const session = terminalSessionManager.getSession(sessionId);
			return session?.isExecuting || false;
		});
	}

	/**
	 * Get count of terminal sessions for a project
	 */
	getTerminalCount(projectId: string): number {
		const context = this.projectContexts.get(projectId);
		return context?.sessionIds.length || 0;
	}

	/**
	 * Sync active stream info to persistence manager (in-memory)
	 * Project contexts are already managed in-memory via this.projectContexts Map
	 */
	private persistContexts(): void {
		// Sync active stream info to persistence manager
		for (const [projectId, context] of this.projectContexts.entries()) {
			for (const sessionId of context.sessionIds) {
				const session = terminalSessionManager.getSession(sessionId);
				if (session && session.isExecuting && session.streamId) {
					terminalPersistenceManager.saveActiveStream(
						sessionId, session.streamId, session.lastCommand || '', projectId
					);
				}
			}
		}
	}

	/**
	 * Load persisted contexts (no-op - contexts are in-memory only)
	 * Project contexts are created on demand via switchToProject()
	 */
	private loadPersistedContexts(): void {
		// No-op: contexts are managed in-memory and rebuilt on demand
	}

	/**
	 * Clear all data (used when clearing application data)
	 */
	clearAll(): void {
		this.projectContexts.clear();
		this.currentProjectId = null;
	}

	/**
	 * Initialize the manager and setup collaborative WebSocket listeners
	 * Project contexts are created on demand via switchToProject()
	 */
	initialize(): void {
		if (typeof window === 'undefined') return;
		this.setupCollaborativeListeners();
	}

	/**
	 * Setup WebSocket listeners for collaborative terminal tab management.
	 * When another user creates/closes a terminal tab, all users in the project
	 * see the tab list update automatically.
	 */
	private setupCollaborativeListeners(): void {
		import('$frontend/lib/utils/ws').then(({ default: ws }) => {
			// Listen for terminal tab created by another user
			ws.on('terminal:tab-created', (data: {
				sessionId: string;
				streamId: string;
				pid: number;
				currentDirectory: string;
				cols: number;
				rows: number;
			}) => {
				debug.log('terminal', `📥 Received terminal:tab-created: ${data.sessionId}`);

				if (!this.currentProjectId) return;
				const context = this.projectContexts.get(this.currentProjectId);
				if (!context) return;

				// Skip if this session already exists locally (we created it)
				if (context.sessionIds.includes(data.sessionId)) {
					debug.log('terminal', `✓ Terminal tab ${data.sessionId} already exists locally, skipping`);
					return;
				}

				// Also skip if it exists in the store already
				const existingStoreSession = terminalStore.getSession(data.sessionId);
				if (existingStoreSession) {
					debug.log('terminal', `✓ Terminal tab ${data.sessionId} already in store, skipping`);
					return;
				}

				// Add the new tab from another user
				debug.log('terminal', `➕ Adding remote terminal tab: ${data.sessionId}`);

				// Extract terminal number from sessionId
				const sessionParts = data.sessionId.split('-');
				const terminalNumber = sessionParts[sessionParts.length - 1] || '1';

				const terminalSession: TerminalSession = {
					id: data.sessionId,
					name: `Terminal ${terminalNumber}`,
					directory: data.currentDirectory,
					lines: [],
					commandHistory: [],
					isActive: false,
					createdAt: new Date(),
					lastUsedAt: new Date(),
					shellType: 'Unknown',
					terminalBuffer: undefined,
					projectId: this.currentProjectId,
					projectPath: context.projectPath
				};

				// Add to store and context
				terminalStore.addSession(terminalSession);
				context.sessionIds.push(data.sessionId);

				// Create in session manager
				terminalSessionManager.createSession(
					data.sessionId,
					this.currentProjectId,
					context.projectPath,
					data.currentDirectory
				);

				// Update nextSessionId to avoid conflicts
				const match = data.sessionId.match(/terminal-(\d+)/);
				if (match) {
					terminalStore.updateNextSessionId(parseInt(match[1], 10) + 1);
				}
			});

			// Listen for terminal tab closed by another user
			ws.on('terminal:tab-closed', (data: { sessionId: string }) => {
				debug.log('terminal', `📥 Received terminal:tab-closed: ${data.sessionId}`);

				if (!this.currentProjectId) return;
				const context = this.projectContexts.get(this.currentProjectId);
				if (!context) return;

				// Skip if session doesn't exist locally (already removed or not ours)
				if (!context.sessionIds.includes(data.sessionId)) {
					debug.log('terminal', `✓ Terminal tab ${data.sessionId} not in our context, skipping`);
					return;
				}

				// Check if session still exists in store (might already be removed locally)
				const existingSession = terminalStore.getSession(data.sessionId);
				if (!existingSession) {
					// Already removed from store, just clean up context
					this.removeSessionFromContext(data.sessionId);
					return;
				}

				// Remove the tab from another user
				debug.log('terminal', `➖ Removing remote terminal tab: ${data.sessionId}`);

				// Remove from context (without calling closeSession to avoid double-kill)
				this.removeSessionFromContext(data.sessionId);

				// Remove from store silently (don't kill PTY - already killed by the user who closed it)
				terminalStore.removeSessionFromStore(data.sessionId);
			});

			debug.log('terminal', '✅ Terminal collaborative listeners registered');
		});
	}

	/**
	 * Get visual indicator data for a project
	 */
	getProjectIndicator(projectId: string): { hasTerminals: boolean; runningCount: number; totalCount: number } {
		const context = this.projectContexts.get(projectId);

		if (!context) {
			return { hasTerminals: false, runningCount: 0, totalCount: 0 };
		}

		let runningCount = 0;
		const countedTerminals = new Set<string>();

		// First check sessions in terminalSessionManager (for current project)
		for (const sessionId of context.sessionIds) {
			const session = terminalSessionManager.getSession(sessionId);
			if (session?.isExecuting) {
				// Extract terminal number to track
				const parts = sessionId.split('-');
				const terminalNumber = parts[parts.length - 1];
				countedTerminals.add(terminalNumber);
				runningCount++;
			}
		}

		// Check persistence manager for active streams (cross-project scenarios)
		const allActiveStreams = terminalPersistenceManager.getAllActiveStreams();
		const processedStreamIds = new Set<string>();

		for (const streamInfo of allActiveStreams) {
			if (processedStreamIds.has(streamInfo.streamId)) continue;

			if (streamInfo.projectId === projectId) {
				const streamParts = streamInfo.sessionId.split('-');
				const terminalNumber = streamParts[streamParts.length - 1];

				if (!countedTerminals.has(terminalNumber)) {
					const hasMatchingTerminal = context.sessionIds.some(sid => {
						const parts = sid.split('-');
						return parts[parts.length - 1] === terminalNumber;
					});

					if (hasMatchingTerminal) {
						countedTerminals.add(terminalNumber);
						runningCount++;
					}
				}

				processedStreamIds.add(streamInfo.streamId);
			}
		}

		return {
			hasTerminals: context.sessionIds.length > 0,
			runningCount,
			totalCount: context.sessionIds.length
		};
	}

	/**
	 * Check and restore active streams for a project
	 */
	private async checkAndRestoreActiveStreams(projectId: string): Promise<void> {
		if (typeof window === 'undefined') return;

		const context = this.projectContexts.get(projectId);
		if (!context) return;

		// Import services dynamically to avoid circular dependency
		const { terminalPersistenceManager } = await import('./persistence.service');
		const { backgroundTerminalService } = await import('./background');

		// Get all active streams from persistence manager
		const allActiveStreams = terminalPersistenceManager.getAllActiveStreams();

		// Check if any active streams belong to this project
		for (const streamInfo of allActiveStreams) {
			if (streamInfo.projectId === projectId) {
				// Extract terminal number from stream's original sessionId
				const streamParts = streamInfo.sessionId.split('-');
				const terminalNumber = streamParts[streamParts.length - 1];

				// Find matching session by terminal number in current context
				for (const sessionId of context.sessionIds) {
					const sessionParts = sessionId.split('-');
					const sessionTerminalNumber = sessionParts[sessionParts.length - 1];

					if (sessionTerminalNumber === terminalNumber) {
						const session = terminalSessionManager.getSession(sessionId);
						if (session) {
							// Restore execution state for this session
							terminalSessionManager.startExecution(
								sessionId,
								streamInfo.command,
								streamInfo.streamId
							);
							terminalStore.setExecutingState(sessionId, true);

							// WebSocket akan otomatis handle reconnection
							break;
						}
					}
				}
			}
		}
	}
}

// Export singleton instance
export const terminalProjectManager = new TerminalProjectManager();