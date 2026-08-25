/**
 * Cline Engine Router
 *
 * Combines status detection, account/login management, and provider presets.
 */

import { createRouter } from '$shared/utils/ws-server';
import { clineStatusHandler } from './status';
import { clineAccountsHandler } from './accounts';
import { clinePresetsHandler } from './presets';

export const clineEngineRouter = createRouter()
	.merge(clineStatusHandler)
	.merge(clineAccountsHandler)
	.merge(clinePresetsHandler);
