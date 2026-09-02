/**
 * Container manager WebSocket router.
 *
 * Reading the list, the detail and the logs is open to any signed-in user who
 * can already reach the host; `containers:action` is registered in
 * ADMIN_ONLY_ROUTES, and opening a shell is gated inside the PtyKit server's
 * own `authorize`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { containersListHandler } from './list';
import { containersActionHandler } from './actions';
import { containersLogsHandler } from './logs';
import { containersTunnelHandler } from './tunnel';

export const containersRouter = createRouter()
	.merge(containersListHandler)
	.merge(containersActionHandler)
	.merge(containersLogsHandler)
	.merge(containersTunnelHandler)
	// Pushed only when a watched host's list actually changed.
	.emit('containers:changed', t.Object({ result: t.Any() }))
	// The sidebar count: containers running on this machine.
	.emit('containers:badge', t.Object({ count: t.Number() }))
	// A disk reading, pushed to whoever asked when it finally lands. It cannot
	// be a response: `system df` takes as long as the host's disk is large.
	.emit('containers:disk-usage-measured', t.Object({ hostId: t.String(), usage: t.Any() }))
	// A cleanup sweep reaching its end, pushed to everyone attached to it — the
	// dialog that started it may be long closed by then.
	.emit('containers:prune-changed', t.Object({ job: t.Any() }))
	// One coalesced push of container output while a log stream is followed.
	.emit(
		'containers:log-chunk',
		t.Object({
			streamId: t.String(),
			hostId: t.String(),
			containerId: t.String(),
			data: t.String(),
			done: t.Optional(t.Boolean()),
			error: t.Optional(t.Union([t.String(), t.Null()]))
		})
	);
