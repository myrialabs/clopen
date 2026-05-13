/**
 * Terminal Stream Persistence
 *
 * Handles terminal stream persistence and reconnection:
 * - Get stream status
 * - Retrieve missed output
 * - Reconnect to existing streams
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { terminalStreamManager } from '../../terminal/stream-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/utils/ws';
import { ptySessionManager } from '../../terminal/pty-session-manager';
import { requireTerminalStreamAccess, requireTerminalLookupAccess } from './access';

export const persistenceHandler = createRouter()
	// Get stream status
	.http('terminal:stream-status', {
		data: t.Object({
			streamId: t.String()
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const { streamId } = data;

		requireTerminalStreamAccess(conn, streamId);

		const status = terminalStreamManager.getStreamStatus(streamId);

		if (!status) {
			throw new Error('Stream not found');
		}

		return status;
	})

	// Get missed output (serialized terminal state)
	.http('terminal:missed-output', {
		data: t.Object({
			sessionId: t.String(),
			streamId: t.Optional(t.String())
		}),
		response: t.Object({
			sessionId: t.String(),
			streamId: t.Union([t.String(), t.Null()]),
			output: t.String(),
			status: t.String(),
			timestamp: t.String()
		})
	}, async ({ data, conn }) => {
		const { sessionId, streamId } = data;

		requireTerminalLookupAccess(conn, sessionId, streamId);

		// Get serialized terminal state from headless xterm
		let output = '';

		if (streamId) {
			output = terminalStreamManager.getSerializedOutput(streamId);
		} else {
			output = terminalStreamManager.getSerializedOutputBySession(sessionId);
		}

		const streamStatus = streamId ? terminalStreamManager.getStreamStatus(streamId) : null;

		return {
			sessionId,
			streamId: streamId || null,
			output,
			status: streamStatus?.status || 'unknown',
			timestamp: new Date().toISOString()
		};
	})

	// Reconnect to stream
	.on('terminal:reconnect', {
		data: t.Object({
			streamId: t.String(),
			sessionId: t.String()
		})
	}, async ({ data, conn }) => {
		const { streamId, sessionId } = data;

		const stream = terminalStreamManager.getStream(streamId);
		if (!stream || !stream.projectId) {
			const fallbackProjectId = ws.getProjectId(conn);
			ws.emit.project(fallbackProjectId, 'terminal:error', {
				sessionId,
				error: 'Access denied'
			});
			return;
		}
		requireTerminalStreamAccess(conn, streamId);
		const projectId = stream.projectId;

		try {
			// Send serialized terminal state (frontend writes it to xterm to restore)
			const serializedOutput = terminalStreamManager.getSerializedOutput(streamId);

			if (serializedOutput) {
				ws.emit.project(projectId, 'terminal:output', {
					sessionId,
					content: serializedOutput,
					timestamp: new Date().toISOString()
				});
			}

			if (stream.status === 'active') {
				// If no dataListeners exist yet (create-session hasn't been called),
				// set up a project-broadcast listener so ongoing output reaches all clients.
				// This listener will be replaced when terminal:create-session is called later.
				const ptySession = ptySessionManager.getSession(sessionId);
				if (ptySession && ptySession.dataListeners.size === 0) {
					debug.log('terminal', `📡 Reconnect: No dataListeners, setting up broadcast listener for session: ${sessionId}`);

					const broadcastListener = (output: string) => {
						const currentSeq = ptySessionManager.getSession(sessionId)?.outputSeq || 0;
						ws.emit.project(projectId, 'terminal:output', {
							sessionId,
							content: output,
							seq: currentSeq,
							projectId,
							timestamp: new Date().toISOString()
						});
					};
					ptySession.dataListeners.add(broadcastListener);
				}
				// No polling needed - dataListener handles ongoing output via ws.emit.project()
			} else {
				// Stream is not active, broadcast exit event (frontend filters by sessionId)
				ws.emit.project(projectId, 'terminal:exit', {
					sessionId,
					exitCode: 0
				});
			}
		} catch (error) {
			debug.error('terminal', 'Error in stream reconnect:', error);
			ws.emit.project(projectId, 'terminal:error', {
				sessionId,
				error: error instanceof Error ? error.message : 'Unknown error'
			});
		}
	})
