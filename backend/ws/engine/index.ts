/**
 * Engine Router
 *
 * Main entry point for AI engine management WebSocket handlers.
 * Merges Claude Code and Open Code engine routers.
 */

import { createRouter } from '$shared/utils/ws-server';
import { claudeCodeEngineRouter } from './claude';
import { openCodeEngineRouter } from './opencode';
import { copilotEngineRouter } from './copilot';
import { codexEngineRouter } from './codex';
import { qwenEngineRouter } from './qwen';
import { piEngineRouter } from './pi';
import { clineEngineRouter } from './cline';
import { engineRestartRouter } from './restart';

export const engineRouter = createRouter()
	.merge(claudeCodeEngineRouter)
	.merge(openCodeEngineRouter)
	.merge(copilotEngineRouter)
	.merge(codexEngineRouter)
	.merge(qwenEngineRouter)
	.merge(piEngineRouter)
	.merge(clineEngineRouter)
	.merge(engineRestartRouter);
