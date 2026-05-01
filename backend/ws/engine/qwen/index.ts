/**
 * Qwen Code Engine Router
 *
 * Combines status detection, account management and provider preset handlers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { qwenStatusHandler } from './status';
import { qwenAccountsHandler } from './accounts';
import { qwenPresetsHandler } from './presets';

export const qwenEngineRouter = createRouter()
	.merge(qwenStatusHandler)
	.merge(qwenAccountsHandler)
	.merge(qwenPresetsHandler);
