/**
 * Projects Router
 *
 * Combines all project WebSocket handlers into a single router.
 *
 * Structure:
 * - crud.ts: HTTP endpoints for CRUD operations (list, create, get, update, delete)
 * - status.ts: Real-time status updates and watching (get-status, watch, unwatch, events)
 * - presence.ts: User presence management (update-presence with broadcast)
 * - overview.ts: Per-project resource usage for every project (projects:overview)
 */

import { createRouter } from '$shared/utils/ws-server';
import { crudHandler } from './crud';
import { statusHandler } from './status';
import { presenceHandler } from './presence';
import { infoHandler } from './info';
import { overviewHandler } from './overview';

export const projectsRouter = createRouter()
	// CRUD Operations (HTTP)
	.merge(crudHandler)

	// Status & Watching (HTTP + Events)
	.merge(statusHandler)

	// Presence Management (HTTP + Broadcast)
	.merge(presenceHandler)

	// Per-project resource info (storage + process-isolated CPU/RAM)
	.merge(infoHandler)

	// Per-project resource usage across every project the caller can see
	.merge(overviewHandler);
