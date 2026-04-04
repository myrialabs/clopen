/**
 * Tunnel Router
 *
 * Combines all tunnel WebSocket handlers into a single router.
 *
 * Structure:
 * - operations.ts: HTTP endpoints for tunnel operations (start, stop, status)
 */

import { createRouter } from '$shared/utils/ws-server';
import { operationsHandler } from './operations';
import { configHandler } from './config';

export const tunnelRouter = createRouter()
	.merge(operationsHandler)
	.merge(configHandler);
