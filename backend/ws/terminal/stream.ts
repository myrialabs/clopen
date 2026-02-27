/**
 * Terminal Stream Events
 *
 * Handles real-time terminal I/O events:
 * - Input (keyboard events)
 * - Output (PTY stdout)
 * - Exit events
 * - Directory changes
 * - Ready notifications
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ptySessionManager } from '../../lib/terminal/pty-session-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/lib/utils/ws';

export const streamHandler = createRouter()
	// Send keyboard input to terminal
	.on('terminal:input', {
		data: t.Object({
			sessionId: t.String(),
			data: t.Any()
		})
	}, async ({ data, conn }) => {
		const { sessionId, data: input } = data;
		const projectId = ws.getProjectId(conn);

		try {
			// Write to PTY stdin
			const success = ptySessionManager.write(sessionId, input);

			if (!success) {
				// Broadcast error (frontend filters by sessionId)
				ws.emit.project(projectId, 'terminal:error', {
					sessionId,
					error: 'Session not found or PTY not available'
				});
			}
		} catch (error) {
			debug.error('terminal', 'Error sending input:', error);
			ws.emit.project(projectId, 'terminal:error', {
				sessionId,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	})

	// Event declarations - Server → Client
	.emit('terminal:ready', t.Object({
		sessionId: t.String(),
		streamId: t.String(),
		pid: t.Number(),
		cols: t.Number(),
		rows: t.Number()
	}))

	.emit('terminal:output', t.Object({
		sessionId: t.String(),
		content: t.String(),
		seq: t.Optional(t.Number()),
		projectId: t.Optional(t.String()),
		timestamp: t.String()
	}))

	.emit('terminal:directory', t.Object({
		sessionId: t.String(),
		newDirectory: t.String()
	}))

	.emit('terminal:exit', t.Object({
		sessionId: t.String(),
		exitCode: t.Number()
	}))

	.emit('terminal:error', t.Object({
		sessionId: t.String(),
		error: t.String()
	}));
