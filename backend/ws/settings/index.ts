/**
 * Settings Router
 *
 * Combines all settings WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (get, update, update-batch)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';

export const settingsRouter = createRouter()
	.merge(crudHandler);
