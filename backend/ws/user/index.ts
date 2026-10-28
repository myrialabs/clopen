/**
 * User Router
 *
 * Combines all user WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for the saved UI state (restore, save)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';

export const userRouter = createRouter()
	.merge(crudHandler);
