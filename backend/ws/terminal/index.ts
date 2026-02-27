/**
 * Terminal Router
 *
 * Combines all terminal WebSocket handlers into a single router.
 * Replaces SSE-based terminal streaming with WebSocket bi-directional communication.
 *
 * Structure:
 * - session.ts: HTTP endpoints for session management (create, resize, kill, cancel, check-shell, pty-status)
 * - stream.ts: Real-time events for terminal I/O (input, output, exit, directory, ready)
 * - persistence.ts: Stream persistence and reconnection (stream-status, missed-output, reconnect)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { sessionHandler } from './session';
import { streamHandler } from './stream';
import { persistenceHandler } from './persistence';

export const terminalRouter = createRouter()
	// Session Management (HTTP)
	.merge(sessionHandler)

	// Stream Events (Real-time I/O)
	.merge(streamHandler)

	// Stream Persistence (HTTP + Events)
	.merge(persistenceHandler)

	// Collaborative broadcast events (Server → Client)
	.emit('terminal:tab-created', t.Object({
		sessionId: t.String(),
		streamId: t.String(),
		pid: t.Number(),
		currentDirectory: t.String(),
		cols: t.Number(),
		rows: t.Number()
	}))
	.emit('terminal:tab-closed', t.Object({
		sessionId: t.String()
	}));
