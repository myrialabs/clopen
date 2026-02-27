/**
 * Persistent PTY Session Manager
 * Manages long-running interactive PTY sessions (one per terminal tab)
 * Supports true TTY interaction with stdin/stdout streaming
 */

import type { IPty } from 'bun-pty';
import { spawn } from 'bun-pty';
import { debug } from '$shared/utils/logger';

export interface PtySession {
	sessionId: string;
	pty: IPty;
	cwd: string;
	projectId?: string;
	createdAt: Date;
	lastActivityAt: Date;
	// Stream listeners
	dataListeners: Set<(data: string) => void>;
	exitListeners: Set<(event: { exitCode: number; signal?: number | string }) => void>;
	// Output batching (performance optimization)
	pendingOutput: string;
	flushScheduled: boolean;
	// Monotonically increasing sequence number for deduplication
	outputSeq: number;
}

class PtySessionManager {
	private sessions = new Map<string, PtySession>();
	private cleanupInterval: Timer | null = null;

	constructor() {
		// Start cleanup interval (remove sessions inactive for >1 hour)
		this.startCleanupInterval();
	}

	/**
	 * Create or get existing PTY session
	 */
	async createSession(
		sessionId: string,
		cwd: string,
		projectId?: string,
		terminalSize?: { cols: number; rows: number }
	): Promise<PtySession> {
		// Return existing session if already created
		const existing = this.sessions.get(sessionId);
		if (existing && existing.pty) {
			debug.log('terminal', `♻️  Reusing existing PTY session: ${sessionId}`);
			existing.lastActivityAt = new Date();
			return existing;
		}

		debug.log('terminal', `🚀 Creating new interactive PTY session: ${sessionId}`);

		// Determine shell based on platform
		const isWindows = process.platform === 'win32';
		let shell: string;
		let shellArgs: string[] = [];

		if (isWindows) {
			// Windows: Use PowerShell in interactive mode
			shell = 'powershell';
			shellArgs = ['-NoLogo']; // Interactive mode, no -Command
		} else {
			// Unix: Use user's default shell or bash
			shell = process.env.SHELL || '/bin/bash';
			shellArgs = []; // Interactive mode, no -c
		}

		// Prepare environment
		const ptyEnv: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value !== undefined) {
				ptyEnv[key] = value;
			}
		}

		// Terminal size
		const cols = terminalSize?.cols || 80;
		const rows = terminalSize?.rows || 24;

		// Add terminal-specific environment variables
		Object.assign(ptyEnv, {
			FORCE_COLOR: '1',
			COLORTERM: 'truecolor',
			TERM: 'xterm-256color',
			COLUMNS: cols.toString(),
			LINES: rows.toString(),
			TERM_PROGRAM: 'xterm.js',
			CLICOLOR: '1',
			LC_ALL: 'en_US.UTF-8',
			LANG: 'en_US.UTF-8'
		});

		// Spawn interactive PTY
		const pty = spawn(shell, shellArgs, {
			name: 'xterm-256color',
			cols,
			rows,
			cwd,
			env: ptyEnv
		});

		debug.log('terminal', `✅ PTY spawned with PID: ${pty.pid}`);

		// CRITICAL: Send initial newline to trigger shell prompt display
		// Without this, shell won't show prompt on first connection
		setTimeout(() => {
			try {
				pty.write('\r');
				debug.log('terminal', '📝 Sent initial newline to trigger prompt');
			} catch (error) {
				debug.error('terminal', 'Failed to send initial newline:', error);
			}
		}, 100);

		// Create session
		const session: PtySession = {
			sessionId,
			pty,
			cwd,
			projectId,
			createdAt: new Date(),
			lastActivityAt: new Date(),
			dataListeners: new Set(),
			exitListeners: new Set(),
			// Initialize batching state
			pendingOutput: '',
			flushScheduled: false,
			outputSeq: 0
		};

		// Setup PTY event handlers with micro-task batching
		pty.onData((data: string) => {
			session.lastActivityAt = new Date();

			// IMPORTANT: Always persist output to stream manager FIRST
			// This ensures output is saved even if there are no active listeners
			try {
				const { terminalStreamManager } = require('./stream-manager');
				const stream = terminalStreamManager.getStreamBySession(sessionId);
				if (stream) {
					terminalStreamManager.addOutput(stream.streamId, data);
				}
			} catch (error) {
				// Stream manager not available yet, skip buffering
			}

			// Batch output for high-frequency data (micro-task batching)
			session.pendingOutput += data;

			if (!session.flushScheduled) {
				session.flushScheduled = true;

				// Use queueMicrotask for minimal latency batching
				queueMicrotask(() => {
					const output = session.pendingOutput;
					session.pendingOutput = '';
					session.flushScheduled = false;

					// Increment sequence number for deduplication
					session.outputSeq++;

					// Broadcast batched output to all listeners
					session.dataListeners.forEach(listener => {
						try {
							listener(output);
						} catch (error) {
							debug.error('terminal', 'Error in data listener:', error);
						}
					});
				});
			}
		});

		pty.onExit((event: { exitCode: number; signal?: number | string }) => {
			debug.log('terminal', `🏁 PTY session ${sessionId} exited with code: ${event.exitCode}`);
			// Broadcast to all listeners
			session.exitListeners.forEach(listener => {
				try {
					listener(event);
				} catch (error) {
					debug.error('terminal', 'Error in exit listener:', error);
				}
			});
			// Remove session
			this.sessions.delete(sessionId);
		});

		// Store session
		this.sessions.set(sessionId, session);

		return session;
	}

	/**
	 * Get existing session
	 */
	getSession(sessionId: string): PtySession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Write data to PTY (stdin)
	 */
	write(sessionId: string, data: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session || !session.pty) {
			debug.error('terminal', `❌ Cannot write to session ${sessionId}: session not found`);
			return false;
		}

		try {
			session.pty.write(data);
			session.lastActivityAt = new Date();
			return true;
		} catch (error) {
			debug.error('terminal', `❌ Error writing to PTY ${sessionId}:`, error);
			return false;
		}
	}

	/**
	 * Resize PTY
	 */
	resize(sessionId: string, cols: number, rows: number): boolean {
		const session = this.sessions.get(sessionId);
		if (!session || !session.pty) {
			return false;
		}

		try {
			session.pty.resize(cols, rows);
			debug.log('terminal', `🔧 PTY ${sessionId} resized to ${cols}x${rows}`);
			return true;
		} catch (error) {
			debug.error('terminal', `❌ Error resizing PTY ${sessionId}:`, error);
			return false;
		}
	}

	/**
	 * Kill PTY session
	 */
	killSession(sessionId: string, signal?: string): boolean {
		const session = this.sessions.get(sessionId);
		if (!session || !session.pty) {
			return false;
		}

		try {
			debug.log('terminal', `💀 Killing PTY session ${sessionId}`);

			if (signal === 'SIGKILL' || signal === '9') {
				session.pty.kill('SIGKILL');
			} else if (signal === 'SIGTERM' || signal === '15') {
				session.pty.kill('SIGTERM');
			} else {
				// Send Ctrl+C first for graceful termination
				session.pty.write('\x03');

				// Follow up with SIGKILL after delay
				setTimeout(() => {
					if (this.sessions.has(sessionId)) {
						try {
							session.pty.kill('SIGKILL');
						} catch {
							// Already dead, ignore
						}
					}
				}, 1000);
			}

			this.sessions.delete(sessionId);
			return true;
		} catch (error) {
			debug.error('terminal', `❌ Error killing PTY ${sessionId}:`, error);
			this.sessions.delete(sessionId); // Remove anyway
			return false;
		}
	}

	/**
	 * Add data listener
	 */
	addDataListener(sessionId: string, listener: (data: string) => void): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		session.dataListeners.add(listener);
		return true;
	}

	/**
	 * Remove data listener
	 */
	removeDataListener(sessionId: string, listener: (data: string) => void): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		return session.dataListeners.delete(listener);
	}

	/**
	 * Add exit listener
	 */
	addExitListener(
		sessionId: string,
		listener: (event: { exitCode: number; signal?: number | string }) => void
	): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		session.exitListeners.add(listener);
		return true;
	}

	/**
	 * Remove exit listener
	 */
	removeExitListener(
		sessionId: string,
		listener: (event: { exitCode: number; signal?: number | string }) => void
	): boolean {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return false;
		}
		return session.exitListeners.delete(listener);
	}

	/**
	 * Get all active sessions
	 */
	getAllSessions(): PtySession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Start cleanup interval
	 */
	private startCleanupInterval() {
		// Run every 15 minutes
		this.cleanupInterval = setInterval(() => {
			this.cleanupInactiveSessions();
		}, 15 * 60 * 1000);
	}

	/**
	 * Cleanup inactive sessions (>1 hour no activity)
	 */
	private cleanupInactiveSessions() {
		const now = new Date();
		const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

		for (const [sessionId, session] of this.sessions.entries()) {
			if (session.lastActivityAt < oneHourAgo) {
				debug.log('terminal', `🧹 Cleaning up inactive session: ${sessionId}`);
				this.killSession(sessionId);
			}
		}
	}

	/**
	 * Cleanup all sessions (on shutdown)
	 */
	dispose() {
		debug.log('terminal', '🧹 Disposing all PTY sessions');

		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
		}

		for (const sessionId of this.sessions.keys()) {
			this.killSession(sessionId, 'SIGKILL');
		}

		this.sessions.clear();
	}
}

// Export singleton instance
export const ptySessionManager = new PtySessionManager();
