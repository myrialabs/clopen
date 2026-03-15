/**
 * Database Health Dashboard — WS Handler
 *
 * Exposes:
 *   db:health:metrics  → collect and return real-time health metrics
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { assertCan } from '../../db-manager/rbac';
import { collectHealthMetrics } from '../../db-manager/health';
import { getDecryptedConnection } from './connections';

const SlowQuerySchema = t.Object({
	query: t.String(),
	durationMs: t.Number(),
	user: t.Optional(t.String()),
	database: t.Optional(t.String()),
	state: t.Optional(t.String())
});

const ConnectionsSchema = t.Object({
	active: t.Number(),
	idle: t.Number(),
	waiting: t.Number(),
	max: t.Union([t.Number(), t.Null()])
});

const TPSSchema = t.Object({
	commits: t.Number(),
	rollbacks: t.Number(),
	tps: t.Number()
});

const MemorySchema = t.Object({
	usedMb: t.Number(),
	totalMb: t.Union([t.Number(), t.Null()]),
	cacheHitRatio: t.Union([t.Number(), t.Null()])
});

const DiskSchema = t.Object({
	dbSizeMb: t.Number()
});

export const healthHandler = createRouter()
	.http(
		'db:health:metrics',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Object({
				timestamp: t.String(),
				dbType: t.String(),
				connections: ConnectionsSchema,
				tps: t.Union([TPSSchema, t.Null()]),
				memory: t.Union([MemorySchema, t.Null()]),
				disk: t.Union([DiskSchema, t.Null()]),
				slowQueries: t.Array(SlowQuerySchema)
			})
		},
		async ({ data, conn }) => {
			assertCan(conn, data.connectionId, 'query:select');
			const config = await getDecryptedConnection(data.connectionId);
			return collectHealthMetrics(config);
		}
	);
