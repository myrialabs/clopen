/**
 * Engine Router
 *
 * Main entry point for AI engine management WebSocket handlers.
 * Merges Claude Code and Open Code engine routers.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { claudeCodeEngineRouter } from './claude';
import { openCodeEngineRouter } from './opencode';
import { copilotEngineRouter } from './copilot';
import { codexEngineRouter } from './codex';
import { qwenEngineRouter } from './qwen';
import { piEngineRouter } from './pi';
import { clineEngineRouter } from './cline';
import { cursorEngineRouter } from './cursor';

export const engineRouter = createRouter()
	.merge(claudeCodeEngineRouter)
	.merge(openCodeEngineRouter)
	.merge(copilotEngineRouter)
	.merge(codexEngineRouter)
	.merge(qwenEngineRouter)
	.merge(piEngineRouter)
	.merge(clineEngineRouter)
	.merge(cursorEngineRouter)

	// ─── Server → client events ───

	/**
	 * Engine-affecting config changed and has been applied.
	 *
	 * A doorbell, not a delivery: it carries the revision and nothing else, and
	 * clients refetch over the routes they already use. This is the one piece of
	 * the removed "Restart Server" button that had to survive — the button's
	 * success path also refreshed the model list, and without an announcement a
	 * newly added provider would sit invisible in the picker until something else
	 * happened to trigger a refetch.
	 */
	.emit('engine:config-changed', t.Object({
		revision: t.Number()
	}));
