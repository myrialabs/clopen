/**
 * Core Terminal Service (WebSocket Version)
 * Handles terminal operations using WebSocket bi-directional communication
 * Replaces SSE-based streaming with WebSocket events
 */

import type { TerminalLine, TerminalSession, TerminalCommand } from '$shared/types/terminal';
import { terminalSessionManager, type TerminalSessionState } from './session.service';
import { backgroundTerminalService } from './background';
import ws from '$frontend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export interface TerminalConnectOptions {
	sessionId: string;
	workingDirectory?: string;
	projectPath?: string;
	projectId?: string;
	terminalSize?: { cols: number; rows: number };
}

export interface StreamingResponse {
	type: 'output' | 'error' | 'directory' | 'exit' | 'complete' | 'clear-screen';
	content?: string;
	newDirectory?: string;
	sessionId?: string;
	projectId?: string;
	timestamp?: string;
}

export class TerminalService {
	private resizeEndpointAvailable: boolean | null = true; // WebSocket always available
	private activeListeners = new Map<string, Array<() => void>>();
	private lastOutputSeq = new Map<string, number>();

	/**
	 * Connect to persistent PTY session with streaming output via WebSocket
	 */
	async connectToSession(
		options: TerminalConnectOptions,
		onData: (data: StreamingResponse) => void
	): Promise<void> {
		const { sessionId, workingDirectory, projectPath, projectId, terminalSize } = options;

		debug.log('terminal', `🔌 Connecting to PTY session via WebSocket: ${sessionId}`);

		// CRITICAL: Cleanup existing listeners BEFORE creating new ones
		// This prevents duplicate event handlers when reconnecting to the same session
		// (e.g., when switching between projects and coming back)
		this.cleanupListeners(sessionId);

		// Reset sequence tracking for fresh deduplication
		this.lastOutputSeq.delete(sessionId);

		// Get or create session state
		const session = terminalSessionManager.getOrCreateSession(
			sessionId,
			projectId,
			projectPath,
			workingDirectory
		);

		// Create unique stream ID for this connection
		const streamId = `${sessionId}-${Date.now()}`;

		// Get current output count to mark where new output starts
		let outputStartIndex = 0;
		if (typeof window !== 'undefined') {
			try {
				const terminalStoreModule = await import('$frontend/lib/stores/features/terminal.svelte');
				const termSession = terminalStoreModule.terminalStore.getSession(sessionId);
				if (termSession && termSession.lines) {
					outputStartIndex = termSession.lines.length;
				}
			} catch {
				// Ignore error, use default 0
			}
		}

		// Setup WebSocket listeners for this session
		const listeners: Array<() => void> = [];

		// Listen for ready event
		const unsubReady = ws.on('terminal:ready', (data) => {
			if (data.sessionId === sessionId) {
				debug.log('terminal', `✅ PTY session ready: ${sessionId} (PID: ${data.pid})`);
				// Update session state with stream ID
				terminalSessionManager.updateSession(sessionId, {
					streamId: data.streamId,
					processId: data.pid,
					isExecuting: true
				});
			}
		});
		listeners.push(unsubReady);

		// Listen for output (with sequence-based deduplication)
		const unsubOutput = ws.on('terminal:output', (data) => {
			if (data.sessionId === sessionId) {
				// Deduplicate: skip if we've already seen this sequence number
				// Multiple WS connections in the same project room can deliver
				// the same terminal:output event multiple times
				if (data.seq !== undefined && data.seq !== null) {
					const lastSeq = this.lastOutputSeq.get(sessionId) || 0;
					if (data.seq <= lastSeq) return;
					this.lastOutputSeq.set(sessionId, data.seq);
				}

				onData({
					type: 'output',
					content: data.content,
					sessionId: data.sessionId,
					projectId: data.projectId,
					timestamp: data.timestamp
				});
			}
		});
		listeners.push(unsubOutput);

		// Listen for directory changes
		const unsubDirectory = ws.on('terminal:directory', (data) => {
			if (data.sessionId === sessionId) {
				terminalSessionManager.updateWorkingDirectory(sessionId, data.newDirectory);
				onData({
					type: 'directory',
					newDirectory: data.newDirectory,
					sessionId: data.sessionId
				});
			}
		});
		listeners.push(unsubDirectory);

		// Listen for exit
		const unsubExit = ws.on('terminal:exit', (data) => {
			if (data.sessionId === sessionId) {
				debug.log('terminal', `🏁 PTY session exited: ${sessionId} (code: ${data.exitCode})`);

				// Clear stream info
				backgroundTerminalService.endStream(sessionId, true);

				onData({
					type: 'exit',
					content: data.exitCode === 0 ? 'success' : 'error',
					sessionId: data.sessionId
				});

				// Cleanup listeners
				this.cleanupListeners(sessionId);
			}
		});
		listeners.push(unsubExit);

		// Listen for errors
		const unsubError = ws.on('terminal:error', (data) => {
			if (data.sessionId === sessionId) {
				debug.error('terminal', `❌ PTY error for ${sessionId}:`, data.error);
				onData({
					type: 'error',
					content: data.error,
					sessionId: data.sessionId
				});
			}
		});
		listeners.push(unsubError);

		// Store listeners for cleanup
		this.activeListeners.set(sessionId, listeners);

		// Create terminal session (now using HTTP pattern)
		try {
			const response = await ws.http('terminal:create-session', {
				sessionId,
				streamId,
				workingDirectory: session.workingDirectory,
				projectPath,
				cols: terminalSize?.cols || 80,
				rows: terminalSize?.rows || 24,
				outputStartIndex
			});

			debug.log('terminal', `✅ Terminal session created:`, response);

			// Update session with response data
			terminalSessionManager.updateSession(sessionId, {
				streamId: response.streamId,
				processId: response.pid,
				isExecuting: true
			});
		} catch (error) {
			debug.error('terminal', `❌ Failed to create terminal session:`, error);
			// Cleanup listeners on error
			this.cleanupListeners(sessionId);
			throw error;
		}
	}

	/**
	 * Send Ctrl+C interrupt signal to a specific session
	 * Always sends the signal regardless of execution state for utility/accessibility
	 */
	async cancelCommand(sessionId: string): Promise<boolean> {
		const session = terminalSessionManager.getSession(sessionId);
		if (!session) {
			return false;
		}

		try {
			// Step 1: Cancel client-side state (if executing)
			if (session.isExecuting) {
				terminalSessionManager.cancelExecution(sessionId);
			}

			// Step 2: Always send Ctrl+C signal via WebSocket
			// This is useful as a utility shortcut even when not executing
			try {
				const data = await ws.http('terminal:cancel', { sessionId }, 10000);
				if (data.sessionId === sessionId) {
					// Clear stream info only if was executing
					if (session.isExecuting) {
						backgroundTerminalService.endStream(sessionId, true);
					}
					return true;
				}
				return false;
			} catch {
				return false;
			}
		} catch (error) {
			debug.error('terminal', 'Error sending Ctrl+C signal:', error);
			return false;
		}
	}

	/**
	 * Resize terminal for a specific session
	 */
	async resizeTerminal(sessionId: string, cols: number, rows: number): Promise<boolean> {
		try {
			debug.log('terminal', `🔧 Resizing terminal ${sessionId} to ${cols}x${rows}`);

			// Send resize request via WebSocket HTTP
			await ws.http('terminal:resize', { sessionId, cols, rows });
			return true;
		} catch (error) {
			debug.error('terminal', 'Error resizing terminal:', error);
			return false;
		}
	}

	/**
	 * Send input to terminal session
	 */
	sendInput(sessionId: string, data: string): void {
		debug.log('terminal', `⌨️ Sending input to ${sessionId}:`, data);
		ws.emit('terminal:input', { sessionId, data });
	}

	/**
	 * Kill terminal session completely
	 */
	async killSession(sessionId: string): Promise<boolean> {
		try {
			debug.log('terminal', `💀 Killing terminal session: ${sessionId}`);

			// Cleanup listeners first
			this.cleanupListeners(sessionId);

			// Send kill request and wait for confirmation
			try {
				const data = await ws.http('terminal:kill-session', { sessionId }, 5000);
				return data.sessionId === sessionId;
			} catch {
				return false;
			}
		} catch (error) {
			debug.error('terminal', 'Error killing session:', error);
			return false;
		}
	}

	/**
	 * Check shell availability
	 */
	async checkShellAvailability(): Promise<{
		available: boolean;
		path: string | null;
		platform: string;
		isWindows: boolean;
		shellType: string;
	}> {
		try {
			return await ws.http('terminal:check-shell', {}, 5000);
		} catch {
			return {
				available: false,
				path: null,
				platform: 'unknown',
				isWindows: false,
				shellType: 'Unknown'
			};
		}
	}

	/**
	 * Get missed output for a session
	 */
	async getMissedOutput(
		sessionId: string,
		streamId?: string,
		fromIndex: number = 0
	): Promise<{
		success: boolean;
		output: string[];
		outputCount: number;
		status: string;
	}> {
		try {
			const data = await ws.http('terminal:missed-output', { sessionId, streamId, fromIndex }, 5000);
			if (data.sessionId === sessionId) {
				return {
					success: true,
					output: data.output,
					outputCount: data.outputCount,
					status: data.status
				};
			}
			return {
				success: false,
				output: [],
				outputCount: 0,
				status: 'invalid_session'
			};
		} catch {
			return {
				success: false,
				output: [],
				outputCount: 0,
				status: 'timeout'
			};
		}
	}

	/**
	 * List active PTY sessions for a project on the backend
	 * Used after browser refresh to discover existing sessions
	 */
	async listProjectSessions(projectId: string): Promise<Array<{
		sessionId: string;
		pid: number;
		cwd: string;
		createdAt: string;
		lastActivityAt: string;
	}>> {
		try {
			const data = await ws.http('terminal:list-sessions', { projectId }, 5000);
			return data.sessions || [];
		} catch {
			return [];
		}
	}

	/**
	 * Cleanup listeners for a session
	 */
	cleanupListeners(sessionId: string): void {
		const listeners = this.activeListeners.get(sessionId);
		if (listeners) {
			listeners.forEach(unsub => unsub());
			this.activeListeners.delete(sessionId);
			this.lastOutputSeq.delete(sessionId);
			debug.log('terminal', `🧹 Cleaned up listeners for ${sessionId}`);
		}
	}

	/**
	 * Cleanup all listeners (call on component unmount)
	 */
	cleanup(): void {
		this.activeListeners.forEach((listeners, sessionId) => {
			listeners.forEach(unsub => unsub());
		});
		this.activeListeners.clear();
		this.lastOutputSeq.clear();
		debug.log('terminal', '🧹 Cleaned up all terminal listeners');
	}
}

// Export singleton instance
export const terminalService = new TerminalService();
