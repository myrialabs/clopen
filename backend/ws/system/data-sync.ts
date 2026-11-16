/**
 * Auto-sync: every open device learns that shared data changed, whoever
 * changed it — another tab, another device, an agent through the `run` tool,
 * a Telegram command, an automation.
 *
 * Each successful write request in one of the namespaces below is announced as
 * `data:changed { namespace }`. The event carries no data; stores refetch what
 * they show. Announcements are coalesced per namespace, so a burst of writes
 * (an agent adding ten skills) costs one refetch.
 *
 * Namespaces with their own live events (chat, files, git, terminal, the
 * preview, the assistant) are not listed: they already stream their changes.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import type { WSRouter } from '$shared/utils/ws-server';
import { routeRisk } from '$backend/control/agent/risk';
import { ws } from '$backend/utils/ws';
import { debug } from '$shared/utils/logger';

export const SYNCED_NAMESPACES = [
	'projects',
	'skills',
	'subagents',
	'rules',
	'toolsets',
	'mcp',
	'integrations',
	'settings',
	'agents',
	'library',
	'permissions',
	'chat-apps',
	'db-client',
	'worktrees',
	'models'
] as const;

export type SyncedNamespace = (typeof SYNCED_NAMESPACES)[number];

const synced = new Set<string>(SYNCED_NAMESPACES);
const COALESCE_MS = 150;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function announceDataChanged(namespace: SyncedNamespace): void {
	if (pending.has(namespace)) return;
	pending.set(
		namespace,
		setTimeout(() => {
			pending.delete(namespace);
			try {
				ws.emit.global('data:changed', { namespace });
			} catch (error) {
				debug.warn('websocket', 'Announcing a data change failed:', error);
			}
		}, COALESCE_MS)
	);
}

export function installDataSync(router: WSRouter<any, any>): void {
	router.setAfterRequest((_conn, action) => {
		const colon = action.indexOf(':');
		if (colon < 0) return;
		const namespace = action.slice(0, colon);
		if (!synced.has(namespace) || routeRisk(action) === 'read') return;
		announceDataChanged(namespace as SyncedNamespace);
	});
}

export const dataSyncRouter = createRouter().emit(
	'data:changed',
	t.Object({ namespace: t.Union(SYNCED_NAMESPACES.map((namespace) => t.Literal(namespace))) })
);
