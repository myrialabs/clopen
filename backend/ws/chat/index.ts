/**
 * Chat Router
 *
 * Combines all chat WebSocket handlers into a single router.
 * Replaces the old SSE-based chat streaming system.
 *
 * Structure:
 * - stream.ts: Real-time chat streaming events (stream, cancel)
 * - background.ts: Background streaming management (start, state, messages, cancel)
 */

import { createRouter } from '$shared/utils/ws-server';
import { streamHandler } from './stream';
import { backgroundHandler } from './background';

export const chatRouter = createRouter()
	// Real-time streaming
	.merge(streamHandler)

	// Background streaming
	.merge(backgroundHandler);
