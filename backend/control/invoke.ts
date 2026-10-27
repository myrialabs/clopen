/**
 * Running a WebSocket route as a user, without a browser.
 *
 * The WebSocket API is already the complete, permission-checked, schema-typed
 * description of everything Clopen can do; a second implementation for remote
 * control would drift from it on day one. So an action calls the route itself,
 * through a virtual connection carrying the user's identity: the router's auth
 * gate (`auth/permissions.ts`), request validation and handler run exactly as
 * they do for a tab, and the handler's return value comes back here instead of
 * down a socket.
 *
 * The router is handed over at startup rather than imported: `backend/ws`
 * imports the chat-app routes, which import this — importing it back would be
 * a cycle.
 */

import type { WSRouter } from '$shared/utils/ws-server';
import { ws } from '$backend/utils/ws';
import type { AuthUser } from '$backend/auth/auth-service';

let router: Pick<WSRouter, 'invoke'> | null = null;

export function registerControlRouter(instance: Pick<WSRouter, 'invoke'>): void {
	router = instance;
}

function requireRouter(): Pick<WSRouter, 'invoke'> {
	if (!router) throw new Error('The control surface is not ready yet');
	return router;
}

export async function callRouteAs<T = unknown>(
	user: Pick<AuthUser, 'id' | 'role'>,
	action: string,
	data: Record<string, unknown> = {},
	projectId: string | null = null
): Promise<T> {
	const conn = ws.openVirtualConnection({ userId: user.id, role: user.role, projectId });
	try {
		return (await requireRouter().invoke(conn, action, data)) as T;
	} finally {
		ws.closeVirtualConnection(conn);
	}
}
