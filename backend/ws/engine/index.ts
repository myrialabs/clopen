/**
 * Engine Router
 *
 * Main entry point for AI engine management WebSocket handlers.
 * Merges Claude Code and Open Code engine routers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { claudeCodeEngineRouter } from './claude';
import { openCodeEngineRouter } from './opencode';

export const engineRouter = createRouter()
	.merge(claudeCodeEngineRouter)
	.merge(openCodeEngineRouter);
