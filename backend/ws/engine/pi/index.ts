/**
 * Pi Engine Router
 *
 * Combines status detection, account/login management, and provider presets.
 */

import { createRouter } from '$shared/utils/ws-server';
import { piStatusHandler } from './status';
import { piAccountsHandler } from './accounts';
import { piPresetsHandler } from './presets';

export const piEngineRouter = createRouter()
	.merge(piStatusHandler)
	.merge(piAccountsHandler)
	.merge(piPresetsHandler);
