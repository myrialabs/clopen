/**
 * Workspace Router
 *
 * Per-project workspace state persistence (dock layout + dock view state).
 *
 * Structure:
 * - state.ts: HTTP endpoints for get/save per-project workspace state
 */

import { createRouter } from '$shared/utils/ws-server';
import { workspaceStateHandler } from './state';

export const workspaceRouter = createRouter()
	.merge(workspaceStateHandler);
