/**
 * Open Code Engine Router
 *
 * Combines Open Code engine handlers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { openCodeStatusHandler } from './status';
import { openCodeProviderHandler } from './providers';

export const openCodeEngineRouter = createRouter()
	.merge(openCodeStatusHandler)
	.merge(openCodeProviderHandler);
