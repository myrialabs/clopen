/**
 * Chat Router
 *
 * Combines all chat WebSocket handlers into a single router.
 */

import { createRouter } from '$shared/utils/ws-server';
import { streamHandler } from './stream';
import { composerHandler } from './composer';

export const chatRouter = createRouter()
	.merge(streamHandler)
	.merge(composerHandler);
