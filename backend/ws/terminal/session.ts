/**
 * Terminal Session Management
 *
 * HTTP endpoints for terminal session lifecycle:
 * - Create session
 * - Resize viewport
 * - Cancel (Ctrl+C)
 * - Kill session
 * - Check shell availability
 * - Get PTY status
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ptySessionManager } from '../../lib/terminal/pty-session-manager';
import { terminalStreamManager } from '../../lib/terminal/stream-manager';
import { debug } from '$shared/utils/logger';
import { resolve } from 'path';
import { isWindows } from '../../lib/terminal/shell-utils';
import { existsSync } from '../../lib/terminal/helpers';
import { ws } from '$backend/lib/utils/ws';
import { activePtyProcesses } from '../../lib/terminal/pty-manager';

export const sessionHandler = createRouter()
	// Create new terminal session
	.http('terminal:create-session', {
		data: t.Object({
			sessionId: t.String(),
			streamId: t.Optional(t.String()),
			workingDirectory: t.Optional(t.String()),
			projectPath: t.Optional(t.String()),
			cols: t.Optional(t.Number()),
			rows: t.Optional(t.Number()),
			outputStartIndex: t.Optional(t.Number())
		}),
		response: t.Object({
			sessionId: t.String(),
			streamId: t.String(),
			pid: t.Number(),
			currentDirectory: t.String(),
			cols: t.Number(),
			rows: t.Number()
		})
	}, async ({ data, conn }) => {
		const {
			sessionId,
			streamId,
			workingDirectory,
			projectPath,
			cols = 80,
			rows = 24,
			outputStartIndex = 0
		} = data;

		const projectId = ws.getProjectId(conn);

		debug.log('terminal', `🌐 WebSocket: Creating PTY session: ${sessionId}`);

		// CRITICAL: Clear ALL existing listeners FIRST before any other operation
		// This prevents duplicate output when reconnecting to a running PTY session
		// (e.g., when switching between projects and coming back)
		const existingPtySession = ptySessionManager.getSession(sessionId);
		if (existingPtySession) {
			const dataListenerCount = existingPtySession.dataListeners.size;
			const exitListenerCount = existingPtySession.exitListeners.size;

			if (dataListenerCount > 0 || exitListenerCount > 0) {
				debug.log('terminal', `🧹 EARLY CLEANUP: Clearing ${dataListenerCount} data listeners and ${exitListenerCount} exit listeners from PTY session: ${sessionId}`);
				existingPtySession.dataListeners.clear();
				existingPtySession.exitListeners.clear();
			}
		}

		// Validate and set working directory
		let cwd = process.cwd();
		let currentDirectory = workingDirectory || '';

		// Priority: workingDirectory > projectPath > home
		if (workingDirectory && workingDirectory !== '~') {
			let resolvedPath: string;
			if (workingDirectory.startsWith('~')) {
				const homeDir = isWindows ? process.env.USERPROFILE : process.env.HOME;
				resolvedPath = workingDirectory.replace('~', homeDir || process.cwd());
			} else {
				resolvedPath = resolve(workingDirectory);
			}

			if (await existsSync(resolvedPath)) {
				cwd = resolvedPath;
				currentDirectory = resolvedPath;
			}
		} else if (projectPath && await existsSync(projectPath)) {
			cwd = projectPath;
			currentDirectory = projectPath;
		} else {
			// Use home directory as fallback
			const homeDir = process.platform === 'win32'
				? process.env.USERPROFILE
				: process.env.HOME;
			cwd = homeDir || process.cwd();
			currentDirectory = cwd;
		}

		// Create or get existing persistent PTY session
		const ptySession = await ptySessionManager.createSession(
			sessionId,
			cwd,
			projectId || '',
			{ cols, rows }
		);

		debug.log('terminal', `✅ PTY session ready with PID: ${ptySession.pty.pid}`);

		// Register with terminal stream manager for persistence
		const registeredStreamId = terminalStreamManager.createStream(
			sessionId,
			'interactive-shell', // No specific command - it's an interactive shell
			ptySession.pty,
			currentDirectory,
			projectPath || '',
			projectId || '',
			streamId,
			outputStartIndex
		);

		// Broadcast initial ready event (frontend filters by sessionId)
		ws.emit.project(projectId, 'terminal:ready', {
			sessionId,
			streamId: registeredStreamId,
			pid: ptySession.pty.pid,
			cols,
			rows
		});

		// Broadcast initial directory info (frontend filters by sessionId)
		ws.emit.project(projectId, 'terminal:directory', {
			sessionId,
			newDirectory: currentDirectory
		});

		// Setup data listener for PTY output - broadcasts to project room
		// Connection-independent: works regardless of which connection set it up
		// All users in the project see terminal output (collaborative)
		// Frontend filters by sessionId to display in the correct terminal tab
		const dataListener = (output: string) => {
			const currentSeq = ptySessionManager.getSession(sessionId)?.outputSeq || 0;
			ws.emit.project(projectId, 'terminal:output', {
				sessionId,
				content: output,
				seq: currentSeq,
				projectId,
				timestamp: new Date().toISOString()
			});
		};

		// Setup exit listener - broadcasts to project room
		const exitListener = (event: { exitCode: number; signal?: number | string }) => {
			debug.log('terminal', `🏁 PTY session ${sessionId} exited with code: ${event.exitCode}`);

			// Update stream status
			const currentStreamId = terminalStreamManager.getStreamBySession(sessionId)?.streamId;
			if (currentStreamId) {
				terminalStreamManager.updateStatus(
					currentStreamId,
					event.exitCode === 0 ? 'completed' : 'error'
				);
			}

			// Broadcast exit event to project room
			ws.emit.project(projectId, 'terminal:exit', {
				sessionId,
				exitCode: event.exitCode
			});
		};

		// Add NEW listeners to PTY session (now guaranteed to be the only listeners)
		ptySessionManager.addDataListener(sessionId, dataListener);
		ptySessionManager.addExitListener(sessionId, exitListener);

		debug.log('terminal', `✅ Added fresh listeners to PTY session ${sessionId}`);

		// Broadcast terminal tab created to all project users
		ws.emit.project(projectId, 'terminal:tab-created', {
			sessionId,
			streamId: registeredStreamId,
			pid: ptySession.pty.pid,
			currentDirectory,
			cols,
			rows
		});

		// Return session info
		return {
			sessionId,
			streamId: registeredStreamId,
			pid: ptySession.pty.pid,
			currentDirectory,
			cols,
			rows
		};
	})

	// Resize terminal viewport
	.http('terminal:resize', {
		data: t.Object({
			sessionId: t.String(),
			cols: t.Number(),
			rows: t.Number()
		}),
		response: t.Object({
			sessionId: t.String(),
			cols: t.Number(),
			rows: t.Number()
		})
	}, async ({ data }) => {
		const { sessionId, cols, rows } = data;

		debug.log('terminal', `🔧 Resizing PTY session ${sessionId} to ${cols}x${rows}`);

		const success = ptySessionManager.resize(sessionId, cols, rows);

		if (!success) {
			throw new Error('No active PTY session found');
		}

		return { sessionId, cols, rows };
	})

	// Send Ctrl+C interrupt signal
	.http('terminal:cancel', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			sessionId: t.String(),
			pid: t.Number()
		})
	}, async ({ data }) => {
		const { sessionId } = data;

		debug.log('terminal', `🛑 Sending Ctrl+C signal to PTY session: ${sessionId}`);

		const session = ptySessionManager.getSession(sessionId);

		if (!session) {
			throw new Error('No active PTY process found for this session');
		}

		const pid = session.pty.pid;

		// Write Ctrl+C character (\x03) to PTY
		session.pty.write('\x03');

		debug.log('terminal', `✅ Sent Ctrl+C signal to PTY session ${sessionId} (PID: ${pid})`);

		return {
			sessionId,
			pid
		};
	})

	// Kill terminal session
	.http('terminal:kill-session', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			sessionId: t.String(),
			pid: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const { sessionId } = data;

		debug.log('terminal', `💀 [kill-session] Killing PTY session: ${sessionId}`);

		const session = ptySessionManager.getSession(sessionId);

		if (!session) {
			debug.log('terminal', `💀 [kill-session] No active PTY session found for: ${sessionId}`);
			return { sessionId };
		}

		const pid = session.pty?.pid;
		debug.log('terminal', `💀 [kill-session] Found PTY session with PID: ${pid}`);

		// Kill the PTY session (handles listener cleanup internally)
		const killed = ptySessionManager.killSession(sessionId);

		if (!killed) {
			debug.error('terminal', `💀 [kill-session] Failed to kill PTY session: ${sessionId}`);
			throw new Error('Failed to kill PTY session');
		}

		debug.log('terminal', `💀 [kill-session] Successfully killed PTY session: ${sessionId} (PID: ${pid})`);

		// Broadcast terminal tab closed to all project users
		const projectId = ws.getProjectId(conn);
		ws.emit.project(projectId, 'terminal:tab-closed', {
			sessionId
		});

		return {
			sessionId,
			pid
		};
	})

	// Check shell availability
	.http('terminal:check-shell', {
		data: t.Object({}),
		response: t.Object({
			available: t.Boolean(),
			path: t.Union([t.String(), t.Null()]),
			platform: t.String(),
			isWindows: t.Boolean(),
			shellType: t.String()
		})
	}, async () => {
		const platformIsWindows = process.platform === 'win32';

		try {
			let shellType = 'Shell';
			let shellPath = null;

			if (platformIsWindows) {
				shellType = 'PowerShell';
				shellPath = 'powershell.exe';
			} else {
				shellType = 'Bash';
				shellPath = '/bin/bash';
			}

			return {
				available: true,
				path: shellPath,
				platform: process.platform,
				isWindows: platformIsWindows,
				shellType
			};
		} catch (error) {
			return {
				available: true,
				path: platformIsWindows ? 'cmd.exe' : '/bin/sh',
				platform: process.platform,
				isWindows: platformIsWindows,
				shellType: platformIsWindows ? 'CMD' : 'Shell'
			};
		}
	})

	// Get PTY status
	.http('terminal:pty-status', {
		data: t.Object({
			sessionId: t.String()
		}),
		response: t.Object({
			isActive: t.Boolean(),
			sessionId: t.String(),
			pid: t.Optional(t.Number()),
			message: t.Optional(t.String())
		})
	}, async ({ data }) => {
		const { sessionId } = data;

		const pty = activePtyProcesses.get(sessionId);

		if (pty) {
			const isActive = pty.pid > 0;

			return {
				isActive,
				sessionId,
				pid: pty.pid
			};
		} else {
			return {
				isActive: false,
				sessionId,
				message: 'PTY not found'
			};
		}
	});
