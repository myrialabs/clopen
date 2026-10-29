/**
 * Port manager WebSocket router.
 *
 * Reading the table, and stopping a process with `ports:kill`.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { portsListHandler } from './list';
import { portsKillHandler } from './kill';

export const portsRouter = createRouter()
	.merge(portsListHandler)
	.merge(portsKillHandler)
	// Pushed only when a watched host's table actually changed.
	.emit('ports:changed', t.Object({ result: t.Any() }))
	// The sidebar count: ports born in a Clopen terminal session.
	.emit('ports:badge', t.Object({ count: t.Number() }));
