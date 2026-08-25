/**
 * Port manager — stopping a process, admin only.
 *
 * The route is listed in ADMIN_ONLY_ROUTES; this handler re-scans before
 * acting rather than trusting the pid the client sent. A table is up to a
 * second old, and a second is long enough for a pid to be recycled onto an
 * unrelated process — signalling that would be indefensible.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { LOCAL_PORT_HOST } from '$shared/types/ports';
import { portMonitor } from '../../ports/monitor';
import { stopPortHolder } from '../../ports/kill';
import { sshConnectionQueries } from '../../database/queries';
import { ws } from '../../utils/ws';
import { debug } from '$shared/utils/logger';

export const portsKillHandler = createRouter().http(
	'ports:kill',
	{
		data: t.Object({
			hostId: t.String({ minLength: 1 }),
			/** Identifies the row the user clicked, so the re-scan can match it. */
			entryKey: t.String({ minLength: 1 })
		}),
		response: t.Any()
	},
	async ({ data, conn }) => {
		const userId = ws.getUserId(conn);
		if (data.hostId !== LOCAL_PORT_HOST) {
			// The route is admin-only, but the host check still runs on the real
			// role rather than a hardcoded one — a gate that trusts its caller is
			// no gate at all.
			sshConnectionQueries.ensureAccess(data.hostId, userId, ws.getRole(conn) === 'admin');
		}

		const fresh = await portMonitor.scanOnce(data.hostId);
		const entry = fresh.entries.find((candidate) => candidate.key === data.entryKey);
		if (!entry) {
			return {
				result: {
					ok: true,
					killedPids: [],
					stoppedFeature: null,
					error: null
				},
				gone: true
			};
		}

		if (!entry.canKill || entry.pid === null) {
			return {
				result: {
					ok: false,
					killedPids: [],
					stoppedFeature: null,
					error: 'That port cannot be stopped from here.'
				},
				gone: false
			};
		}

		debug.log('ports', `stopping ${entry.protocol}/${entry.port} (pid ${entry.pid}) on ${data.hostId}`);

		const result = await portMonitor.withHost(data.hostId, (runner, platform) =>
			stopPortHolder(
				{ pid: entry.pid as number, ownerFeature: entry.origin.ownerFeature, ownerId: entry.origin.ownerId },
				runner,
				platform
			)
		);

		// Whatever happened, the table moved — push it now rather than at the
		// next tick, so the row disappears as the button is released.
		portMonitor.invalidate(data.hostId);

		return { result, gone: false };
	}
);
