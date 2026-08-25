/**
 * Snapshot Router
 *
 * Combines all snapshot WebSocket handlers into a single router.
 *
 * Structure:
 * - restore.ts: Unified restore operation (replaces undo + redo)
 * - timeline.ts: Timeline visualization data
 * - content.ts: Pre-checkpoint file content (AI gutter diff base)
 */

import { createRouter } from '$shared/utils/ws-server';
import { restoreHandler } from './restore';
import { timelineHandler } from './timeline';
import { contentHandler } from './content';

export const snapshotRouter = createRouter()
	.merge(restoreHandler)
	.merge(timelineHandler)
	.merge(contentHandler);
