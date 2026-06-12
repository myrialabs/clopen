/**
 * Git Router
 * Combines all git WebSocket handlers into a single router.
 */

import { createRouter } from '$shared/utils/ws-server';
import { statusHandler } from './status';
import { stagingHandler } from './staging';
import { commitHandler } from './commit';
import { diffHandler } from './diff';
import { branchHandler } from './branch';
import { logHandler } from './log';
import { remoteHandler } from './remote';
import { conflictHandler } from './conflict';
import { commitMessageHandler } from './commit-message';
import { branchNameHandler } from './branch-name';

export const gitRouter = createRouter()
	.merge(statusHandler)
	.merge(stagingHandler)
	.merge(commitHandler)
	.merge(diffHandler)
	.merge(branchHandler)
	.merge(logHandler)
	.merge(remoteHandler)
	.merge(conflictHandler)
	.merge(commitMessageHandler)
	.merge(branchNameHandler);
