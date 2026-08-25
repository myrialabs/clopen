/**
 * Port manager — reading the table.
 *
 * Watching is per connection: a client asks for a host when it opens that tab
 * and is pushed a fresh table whenever the host's ports actually change. The
 * watch is torn down when the socket closes, so a browser tab that vanishes
 * cannot leave a host being polled forever.
 *
 * Reading is open to any signed-in user; stopping a process is not, and lives
 * in kill.ts.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { portMonitor } from '../../ports/monitor';
import { sshConnectionQueries } from '../../database/queries';
import { ws } from '../../utils/ws';

/**
 * A member may only watch an SSH host they can already reach. The local
 * machine is watchable by anyone signed in — it is the machine they are
 * already using Clopen on.
 */
function requireHostAccess(conn: Parameters<typeof ws.getUserId>[0], hostId: string): void {
	if (hostId === LOCAL_PORT_HOST) return;
	const userId = ws.getUserId(conn);
	const isAdmin = ws.getRole(conn) === 'admin';
	sshConnectionQueries.ensureAccess(hostId, userId, isAdmin);
}

const hostSchema = t.Object({ hostId: t.String({ minLength: 1 }) });

export const portsListHandler = createRouter()
	.http('ports:watch', { data: hostSchema, response: t.Any() }, async ({ data, conn }) => {
		requireHostAccess(conn, data.hostId);
		const userId = ws.getUserId(conn);

		const result = await portMonitor.watch(data.hostId, userId);
		// The watch belongs to this socket; a reload must not leave it running.
		ws.addCleanup(conn, () => portMonitor.unwatch(data.hostId, userId));
		return { result };
	})

	.http('ports:unwatch', { data: hostSchema, response: t.Any() }, async ({ data, conn }) => {
		portMonitor.unwatch(data.hostId, ws.getUserId(conn));
		return { ok: true };
	})

	/**
	 * The sidebar count, on demand.
	 *
	 * Pushes only carry changes, so a client that has just loaded — or just
	 * reconnected — has no way to learn a count that has been steady. Asking for
	 * it is how the badge survives a page refresh instead of reading zero until
	 * something happens to move it.
	 */
	.http('ports:summary', { data: t.Object({}), response: t.Any() }, async () => ({
		count: await portMonitor.refreshBadge()
	}));
