/**
 * Database Manager - Query History Handler
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { queryHistoryQueries } from '../../database/queries';

const QueryHistoryEntrySchema = t.Object({
	id: t.String(),
	connectionId: t.String(),
	connectionName: t.String(),
	connectionType: t.String(),
	sql: t.String(),
	executionTimeMs: t.Number(),
	rowCount: t.Number(),
	error: t.Union([t.String(), t.Null()]),
	executedAt: t.String(),
	isFavorite: t.Boolean()
});

export const historyHandler = createRouter()
	// List history entries (optional connection filter)
	.http(
		'db:history:list',
		{
			data: t.Object({
				connectionId: t.Optional(t.String())
			}),
			response: t.Array(QueryHistoryEntrySchema)
		},
		async ({ data }) => {
			if (data.connectionId) {
				return queryHistoryQueries.listByConnection(data.connectionId, 100);
			}
			return queryHistoryQueries.listAll(100);
		}
	)

	// Delete a single history entry
	.http(
		'db:history:delete',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data }) => {
			queryHistoryQueries.deleteEntry(data.id);
			return { ok: true };
		}
	)

	// Toggle is_favorite for a history entry
	.http(
		'db:history:favorite',
		{
			data: t.Object({ id: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data }) => {
			queryHistoryQueries.toggleFavorite(data.id);
			return { ok: true };
		}
	)

	// Clear all history for a connection
	.http(
		'db:history:clear',
		{
			data: t.Object({ connectionId: t.String() }),
			response: t.Object({ ok: t.Boolean() })
		},
		async ({ data }) => {
			queryHistoryQueries.clearByConnection(data.connectionId);
			return { ok: true };
		}
	);
