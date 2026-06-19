/**
 * Restart-all-engines handler.
 *
 * Disposes every cached engine instance (global + per-project) and the shared
 * OpenCode server/client so the next chat turn re-initialises from scratch.
 * Needed after changing MCP servers (install/uninstall/enable/disable/config)
 * or other global engine config — the engines read that config when they
 * (re)initialise, not mid-session.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { debug } from '$shared/utils/logger';
import { disposeAllEngines } from '../../engine';
import { disposeOpenCodeClient } from '../../engine/adapters/opencode/server';
import { streamManager } from '../../chat';

export const engineRestartRouter = createRouter()
	.http('engine:restart-all', {
		data: t.Object({
			force: t.Optional(t.Boolean()),
		}),
		response: t.Object({
			success: t.Boolean(),
			activeChats: t.Optional(t.Number()),
			needsConfirmation: t.Optional(t.Boolean()),
		})
	}, async ({ data }) => {
		const activeStreams = streamManager.getActiveStreams();

		// Restarting kills in-flight chats — ask first unless forced.
		if (activeStreams.length > 0 && !data.force) {
			return { success: false, activeChats: activeStreams.length, needsConfirmation: true };
		}

		if (activeStreams.length > 0) {
			debug.log('engine', `Force-aborting ${activeStreams.length} active stream(s) before restart-all`);
			for (const stream of activeStreams) {
				try {
					await streamManager.cancelStream(stream.streamId);
				} catch (error) {
					debug.warn('engine', `Failed to abort stream ${stream.streamId}:`, error);
				}
			}
		}

		await disposeAllEngines();
		// OpenCode keeps a separate persistent server/client beyond the engine
		// instance — purge it too so it respawns with fresh MCP config.
		await disposeOpenCodeClient(true);

		debug.log('engine', 'All engines disposed (restart-all). Will re-initialize on next use.');
		return { success: true };
	});
