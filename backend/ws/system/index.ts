/**
 * System Router
 *
 * Combines all system WebSocket handlers into a single router.
 *
 * Structure:
 * - operations.ts: HTTP endpoints for system operations (clear-data)
 */

import { createRouter } from '$shared/utils/ws-server';
import { t } from 'elysia';
import { operationsHandler } from './operations';

export const systemRouter = createRouter()
	.merge(operationsHandler)
	// Declare system:update-completed event (broadcast after successful package update)
	.emit('system:update-completed', t.Object({
		fromVersion: t.String(),
		toVersion: t.String()
	}));
