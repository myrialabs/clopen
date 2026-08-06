/**
 * Cursor Engine Router
 *
 * Combines status detection and account management handlers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { cursorStatusHandler } from './status';
import { cursorAccountsHandler } from './accounts';

export const cursorEngineRouter = createRouter()
	.merge(cursorStatusHandler)
	.merge(cursorAccountsHandler);
