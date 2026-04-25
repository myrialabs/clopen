/**
 * db-client WebSocket router.
 *
 * Phase 1 ships connection CRUD + health.
 * Schema, query, structure, and data CRUD handlers land in Phase 2.
 */

import { createRouter } from '$shared/utils/ws-server';
import { connectionsHandler } from './connections';

export const dbClientRouter = createRouter()
	.merge(connectionsHandler);
