/**
 * Which connections are looking at a Preview right now.
 *
 * Most preview events describe state every device must stay in step with (tabs
 * opened or closed, an agent taking control, a dialog) and still go to the
 * whole project. A few are a panel's live detail and are frequent: every line
 * the previewed page logs, and every step of the agent's cursor. Those only go
 * to connections with a Preview mounted. A panel that mounts later loses
 * nothing: the console is seeded from its history (`preview:browser-console-get`)
 * and the agent's last cursor position is replayed on `preview:watch`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import type { WSAPI } from '$backend/ws';
import { scopeProjectId } from '$shared/utils/workspace-scope';

const watching = new Set<string>();

/** Last known agent cursor per project and tab, replayed to a new watcher. */
const lastCursor = new Map<string, Map<string, WSAPI['server']['preview:browser-mcp-cursor-position']>>();

/** Send a Preview-detail event to the project's connections that have a Preview open. */
export function emitToPreviewWatchers<K extends keyof WSAPI['server']>(
	projectId: string,
	event: K,
	payload: WSAPI['server'][K]
): void {
	ws.emit.projectWhere(projectId, (connectionId) => watching.has(connectionId), event, payload);
}

/** Remember where the agent's cursor came to rest on a tab. */
export function rememberAgentCursor(
	projectId: string,
	cursor: WSAPI['server']['preview:browser-mcp-cursor-position']
): void {
	let tabs = lastCursor.get(projectId);
	if (!tabs) {
		tabs = new Map();
		lastCursor.set(projectId, tabs);
	}
	tabs.set(cursor.sessionId, cursor);
}

/** The agent let go of a tab: there is no cursor to show on it any more. */
export function forgetAgentCursor(projectId: string, tabId: string): void {
	lastCursor.get(projectId)?.delete(tabId);
}

export const previewWatchHandler = createRouter()
	/**
	 * A Preview was mounted (`watching: true`) or the last one went away
	 * (`false`). Clients send it again after a reconnect.
	 */
	.on('preview:watch', {
		data: t.Object({
			watching: t.Boolean()
		})
	}, ({ conn, data }) => {
		const connectionId = ws.getConnectionId(conn);
		if (!connectionId) return;
		if (!data.watching) {
			watching.delete(connectionId);
			return;
		}
		if (!watching.has(connectionId)) {
			watching.add(connectionId);
			ws.addCleanup(conn, () => watching.delete(connectionId));
		}

		let projectId: string;
		try {
			projectId = scopeProjectId(ws.getProjectId(conn));
		} catch {
			return; // No project yet — nothing to replay.
		}
		for (const cursor of lastCursor.get(projectId)?.values() ?? []) {
			ws.sendToConnectionId(
				connectionId,
				JSON.stringify({ action: 'preview:browser-mcp-cursor-position', payload: cursor })
			);
		}
	});
