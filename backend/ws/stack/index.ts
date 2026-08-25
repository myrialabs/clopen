/**
 * Stack Router
 *
 * Entry point for install-related WebSocket handlers:
 *  - stack:status / status-all — detection + recipe
 *  - stack:install-start / install-cancel / install-session
 *  - Server → client stream events
 */

import { createRouter } from '$shared/utils/ws-server';
import { stackStatusHandler } from './status';
import { stackInstallHandler } from './install';

export const stackRouter = createRouter()
	.merge(stackStatusHandler)
	.merge(stackInstallHandler);
