/**
 * Copilot Engine Router
 *
 * Combines status detection and account management handlers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { copilotStatusHandler } from './status';
import { copilotAccountsHandler } from './accounts';

export const copilotEngineRouter = createRouter()
	.merge(copilotStatusHandler)
	.merge(copilotAccountsHandler);
