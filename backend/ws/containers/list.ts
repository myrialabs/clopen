/**
 * Containers — reading the list.
 *
 * Watching is per connection: a client asks for a host when it opens that panel
 * and is pushed a fresh listing whenever the host's containers actually change.
 * The watch is torn down when the socket closes, so a browser tab that vanishes
 * cannot leave a host being polled forever.
 *
 * Reading is open to any signed-in user who can already reach the host. Acting
 * on a container is not, and lives in actions.ts.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { LOCAL_HOST_ID } from '$shared/types/host';
import { containerMonitor } from '../../containers/monitor';
import { inspectContainer, readStats } from '../../containers/actions';
import { requestDiskUsage } from '../../containers/disk-usage';
import { stopLogStreamsForUser } from '../../containers/logs';
import { sshConnectionQueries } from '../../database/queries';
import { ws } from '../../utils/ws';

/**
 * A member may only watch an SSH host they can already reach. The local machine
 * is watchable by anyone signed in — it is the machine they are already using
 * Clopen on.
 */
export function requireHostAccess(conn: Parameters<typeof ws.getUserId>[0], hostId: string): void {
	if (hostId === LOCAL_HOST_ID) return;
	const userId = ws.getUserId(conn);
	const isAdmin = ws.getRole(conn) === 'admin';
	sshConnectionQueries.ensureAccess(hostId, userId, isAdmin);
}

const hostSchema = t.Object({ hostId: t.String({ minLength: 1 }) });

export const containersListHandler = createRouter()
	.http('containers:watch', { data: hostSchema, response: t.Any() }, async ({ data, conn }) => {
		requireHostAccess(conn, data.hostId);
		const userId = ws.getUserId(conn);

		const result = await containerMonitor.watch(data.hostId, userId);
		// The watch belongs to this socket; a reload must not leave it running,
		// and neither must the log streams opened from the same panel.
		ws.addCleanup(conn, () => {
			containerMonitor.unwatch(data.hostId, userId);
			stopLogStreamsForUser(userId);
		});
		return { result };
	})

	.http('containers:unwatch', { data: hostSchema, response: t.Any() }, async ({ data, conn }) => {
		containerMonitor.unwatch(data.hostId, ws.getUserId(conn));
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
	.http('containers:summary', { data: t.Object({}), response: t.Any() }, async () => ({
		count: await containerMonitor.refreshBadge()
	}))

	/**
	 * Everything `inspect` knows, read only when a detail pane opens.
	 *
	 * Environment values are stripped for anyone but an admin. A container's env
	 * is where its database password lives, and this panel is reachable by every
	 * member and through a shared Remote Access link — so the keys are shown,
	 * which is what makes the pane useful, and the values are not.
	 */
	.http(
		'containers:inspect',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				containerId: t.String({ minLength: 12 })
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireHostAccess(conn, data.hostId);
			const detail = await inspectContainer(data.hostId, data.containerId);
			if (!detail || ws.getRole(conn) === 'admin') return { detail, envRedacted: false };

			return {
				detail: {
					...detail,
					env: detail.env.map((line) => {
						const split = line.indexOf('=');
						return split <= 0 ? line : `${line.slice(0, split)}=`;
					})
				},
				envRedacted: true
			};
		}
	)

	/**
	 * What the host is holding and how much of it is reclaimable.
	 *
	 * Read-only, so any member may ask — it is the same `system df` they would
	 * run in a terminal, and knowing the disk is full is not a privilege.
	 *
	 * Returns whatever was last measured, immediately, and reports whether a
	 * fresh reading is on its way; that one arrives as
	 * `containers:disk-usage-measured`. The measurement cannot be awaited here
	 * because its duration is set by how much disk the host holds — see
	 * `backend/containers/disk-usage.ts`.
	 */
	.http(
		'containers:disk-usage',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				/** The Re-check button: measure again even if the cache is fresh. */
				force: t.Optional(t.Boolean())
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireHostAccess(conn, data.hostId);
			return requestDiskUsage(data.hostId, ws.getUserId(conn), data.force ?? false);
		}
	)

	/** One live sample of what a container is consuming, when a pane asks. */
	.http(
		'containers:stats',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				containerId: t.String({ minLength: 12 })
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireHostAccess(conn, data.hostId);
			return { stats: await readStats(data.hostId, data.containerId) };
		}
	);
