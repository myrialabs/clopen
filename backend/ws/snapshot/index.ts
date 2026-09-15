/**
 * Snapshot Router
 *
 * Combines all snapshot WebSocket handlers into a single router.
 *
 * Structure:
 * - restore.ts: Unified restore operation (replaces undo + redo)
 * - timeline.ts: Timeline visualization data
 * - changes.ts: Per-turn file changes and their content, which is what the
 *   AI-change indicators, the editor gutter and the Changes tab all read
 */

import { createRouter } from '$shared/utils/ws-server';
import { restoreHandler } from './restore';
import { timelineHandler } from './timeline';
import { changesHandler } from './changes';

export const snapshotRouter = createRouter()
	.merge(restoreHandler)
	.merge(timelineHandler)
	.merge(changesHandler);
