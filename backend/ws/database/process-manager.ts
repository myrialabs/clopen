/**
 * Database Manager — Process Manager WS Handler
 *
 * Exposes:
 *   db:processes:list  → list active sessions/queries
 *   db:processes:kill  → kill a session or cancel a query
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { assertCan } from '../../db-manager/rbac';
import { listProcesses, killProcess } from '../../db-manager/process-manager';
import { getDecryptedConnection } from './connections';

const ProcessSchema = t.Object({
	id: t.String(),
	user: t.Optional(t.String()),
	host: t.Optional(t.String()),
	database: t.Optional(t.String()),
	command: t.Optional(t.String()),
	state: t.Optional(t.String()),
	query: t.Optional(t.String()),
	timeSeconds: t.Optional(t.Number()),
	cpuMs: t.Optional(t.Number()),
	reads: t.Optional(t.Number()),
	writes: t.Optional(t.Number()),
	raw: t.Record(t.String(), t.Unknown())
});

export const processManagerHandler = createRouter()
	// List active processes / sessions
	.http(
		'db:processes:list',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Object({
				processes: t.Array(ProcessSchema),
				fetchedAt: t.String(),
				dbType: t.String()
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return listProcesses(config);
		}
	)

	// Kill / cancel a process
	.http(
		'db:processes:kill',
		{
			data: t.Object({
				connectionId: t.String(),
				processId: t.String(),
				mode: t.Optional(t.Union([t.Literal('query'), t.Literal('connection')]))
			}),
			response: t.Object({
				ok: t.Boolean(),
				message: t.String()
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:dml');
			const config = await getDecryptedConnection(data.connectionId);
			return killProcess(config, data.processId, data.mode ?? 'query');
		}
	);
