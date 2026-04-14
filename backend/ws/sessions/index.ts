/**
 * Sessions Router
 *
 * Combines all session WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (list, create, get, get-shared, update, delete)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';

export const sessionsRouter = createRouter()
	.merge(crudHandler)
	// Collaborative broadcast events (Server → Client)
	// Notification: a new session is available (no auto-switch)
	.emit('sessions:session-available', t.Object({
		session: t.Any()
	}))
	// Notification: a session was deleted by another user
	.emit('sessions:session-deleted', t.Object({
		sessionId: t.String(),
		projectId: t.String()
	}));
