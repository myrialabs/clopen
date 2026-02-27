/**
 * Claude Engine Router
 *
 * Combines status detection and account management handlers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { claudeCodeStatusHandler } from './status';
import { accountsHandler } from './accounts';

export const claudeCodeEngineRouter = createRouter()
	.merge(claudeCodeStatusHandler)
	.merge(accountsHandler);
