/**
 * Messages Router
 *
 * Combines all message WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (list, get, delete)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';

export const messagesRouter = createRouter()
	.merge(crudHandler);
