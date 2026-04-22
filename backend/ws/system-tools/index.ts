/**
 * System Tools Router
 *
 * Entry point for install-related WebSocket handlers:
 *  - system-tools:status / status-all — detection + recipe
 *  - system-tools:install-start / install-cancel / install-session
 *  - Server → client stream events
 */

import { createRouter } from '$shared/utils/ws-server';
import { systemToolsStatusHandler } from './status';
import { systemToolsInstallHandler } from './install';

export const systemToolsRouter = createRouter()
	.merge(systemToolsStatusHandler)
	.merge(systemToolsInstallHandler);
