/**
 * Snapshot Router
 *
 * Combines all snapshot WebSocket handlers into a single router.
 *
 * Structure:
 * - restore.ts: Unified restore operation (replaces undo + redo)
 * - timeline.ts: Timeline visualization data
 * - changes.ts: List of files changed in a checkpoint
 * - file-diff.ts: Old/new file content for diff display
 * - dismissed-changes.ts: Per-session mark list (banner-only, restore-safe)
 */

import { createRouter } from '$shared/utils/ws-server';
import { restoreHandler } from './restore';
import { timelineHandler } from './timeline';
import { changesHandler } from './changes';
import { fileDiffHandler } from './file-diff';
import { dismissedChangesHandler } from './dismissed-changes';

export const snapshotRouter = createRouter()
	.merge(restoreHandler)
	.merge(timelineHandler)
	.merge(changesHandler)
	.merge(fileDiffHandler)
	.merge(dismissedChangesHandler);
