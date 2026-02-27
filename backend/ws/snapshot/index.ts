/**
 * Snapshot Router
 *
 * Combines all snapshot WebSocket handlers into a single router.
 *
 * Structure:
 * - restore.ts: Unified restore operation (replaces undo + redo)
 * - timeline.ts: Timeline visualization data
 */

import { createRouter } from '$shared/utils/ws-server';
import { restoreHandler } from './restore';
import { timelineHandler } from './timeline';

export const snapshotRouter = createRouter()
	.merge(restoreHandler)
	.merge(timelineHandler);
