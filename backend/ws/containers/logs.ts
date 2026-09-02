/**
 * Containers — following a container's output.
 *
 * Open to any member who can reach the host: reading a log changes nothing.
 * The stream belongs to the socket that asked for it, so closing the tab stops
 * the `docker logs -f` behind it rather than leaving a process running on
 * someone's machine with nothing listening.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { startLogStream, stopLogStream } from '../../containers/logs';
import { requireHostAccess } from './list';
import { ws } from '../../utils/ws';

export const containersLogsHandler = createRouter()
	.http(
		'containers:logs-start',
		{
			data: t.Object({
				hostId: t.String({ minLength: 1 }),
				containerId: t.String({ minLength: 12 })
			}),
			response: t.Any()
		},
		async ({ data, conn }) => {
			requireHostAccess(conn, data.hostId);
			const userId = ws.getUserId(conn);

			const started = await startLogStream(data.hostId, data.containerId, userId);
			ws.addCleanup(conn, () => stopLogStream(started.streamId, userId));
			return started;
		}
	)

	.http(
		'containers:logs-stop',
		{ data: t.Object({ streamId: t.String({ minLength: 1 }) }), response: t.Any() },
		async ({ data, conn }) => {
			stopLogStream(data.streamId, ws.getUserId(conn));
			return { ok: true };
		}
	);
