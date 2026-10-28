/**
 * Projects Router
 *
 * Combines all project WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (list, create, get, update, delete)
 * - status.ts: Live chat-stream status of every project (get-status, join, broadcast)
 * - overview.ts: Per-project resource usage for every project (projects:overview)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';
import { statusHandler } from './status';
import { infoHandler } from './info';
import { overviewHandler } from './overview';

export const projectsRouter = createRouter()
	// CRUD Operations (HTTP)
	.merge(crudHandler)

	// Live stream status (HTTP + Events)
	.merge(statusHandler)

	// Per-project resource info (storage + process-isolated CPU/RAM)
	.merge(infoHandler)

	// Per-project resource usage across every project
	.merge(overviewHandler);
