/**
 * Projects Router
 *
 * Combines all project WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (list, create, get, update, delete)
 * - status.ts: Real-time status updates and watching (get-status, watch, unwatch, events)
 * - presence.ts: User presence management (update-presence with broadcast)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';
import { statusHandler } from './status';
import { presenceHandler } from './presence';

export const projectsRouter = createRouter()
	// CRUD Operations (HTTP)
	.merge(crudHandler)

	// Status & Watching (HTTP + Events)
	.merge(statusHandler)

	// Presence Management (HTTP + Broadcast)
	.merge(presenceHandler);
