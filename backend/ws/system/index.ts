/**
 * System Router
 *
 * Combines all system WebSocket handlers into a single router.
 *
 * Structure:
 * - operations.ts: HTTP endpoints for system operations (clear-data)
 */

import { createRouter } from '$shared/utils/ws-server';
import { operationsHandler } from './operations';

export const systemRouter = createRouter()
	.merge(operationsHandler);
