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

export const tunnelRouter = createRouter()
	.merge(operationsHandler);
