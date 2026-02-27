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
import { terminalStreamManager } from '../../lib/terminal/stream-manager';
import { debug } from '$shared/utils/logger';
import { ws } from '$backend/lib/utils/ws';
import { ptySessionManager } from '../../lib/terminal/pty-session-manager';

export const persistenceHandler = createRouter()
	// Get stream status
	.http('terminal:stream-status', {
		data: t.Object({
			streamId: t.String()
		}),
		response: t.Any()
	}, async ({ data }) => {
		const { streamId } = data;

		const status = terminalStreamManager.getStreamStatus(streamId);

		if (!status) {
			throw new Error('Stream not found');
		}

		return status;
	})

	// Get missed output
	.http('terminal:missed-output', {
		data: t.Object({
			sessionId: t.String(),
			streamId: t.Optional(t.String()),
			fromIndex: t.Optional(t.Number())
		}),
		response: t.Object({
			sessionId: t.String(),
			streamId: t.Union([t.String(), t.Null()]),
			output: t.Array(t.String()),
			outputCount: t.Number(),
			status: t.String(),
			fromIndex: t.Number(),
			timestamp: t.String()
		})
	}, async ({ data }) => {
		const { sessionId, streamId, fromIndex = 0 } = data;

		// Try to get output from stream manager (memory or cache)
		let output: string[] = [];

		if (streamId) {
			// If streamId is provided, get output from that specific stream
			output = terminalStreamManager.getOutput(streamId, fromIndex);
		} else {
			// Otherwise try to load cached output for the session
			const cachedOutput = terminalStreamManager.loadCachedOutput(sessionId);
			if (cachedOutput) {
				output = cachedOutput.slice(fromIndex);
			}
		}

		// Get stream status if available
		const streamStatus = streamId ? terminalStreamManager.getStreamStatus(streamId) : null;

		return {
			sessionId,
			streamId: streamId || null,
			output,
			outputCount: output.length,
			status: streamStatus?.status || 'unknown',
			fromIndex,
			timestamp: new Date().toISOString()
		};
	})

	// Reconnect to stream
	.on('terminal:reconnect', {
		data: t.Object({
			streamId: t.String(),
			sessionId: t.String(),
			fromIndex: t.Optional(t.Number())
		})
	}, async ({ data, conn }) => {
		const { streamId, sessionId, fromIndex = 0 } = data;
		const projectId = ws.getProjectId(conn);

		const stream = terminalStreamManager.getStream(streamId);

		if (!stream) {
			ws.emit.project(projectId, 'terminal:error', {
				sessionId,
				error: 'Stream not found'
			});
			return;
		}

		try {
			// Broadcast missed output (frontend filters by sessionId for one-time replay)
			const existingOutput = terminalStreamManager.getOutput(streamId, fromIndex);

			if (existingOutput.length > 0) {
				for (const output of existingOutput) {
					ws.emit.project(projectId, 'terminal:output', {
						sessionId,
						content: output,
						timestamp: new Date().toISOString()
					});
				}
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
