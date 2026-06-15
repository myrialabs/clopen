/**
 * Snapshot Changes Handler
 *
 * Returns the list of files changed in a checkpoint.
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { snapshotQueries } from '../../database/queries';
import { requireSessionAccess } from '../access';

export const changesHandler = createRouter()
	.http('snapshot:get-changes', {
		data: t.Object({
			messageId: t.String(),
			sessionId: t.String()
		}),
		response: t.Object({
			files: t.Array(t.Object({
				filepath: t.String(),
				oldHash: t.String(),
				newHash: t.String()
			}))
		})
	}, async ({ data, conn }) => {
		requireSessionAccess(conn, data.sessionId);

		const snapshot = snapshotQueries.getByMessageId(data.messageId);
		if (!snapshot || !snapshot.session_changes) {
			return { files: [] };
		}

		try {
			const changes = JSON.parse(snapshot.session_changes as string) as Record<string, { oldHash: string; newHash: string }>;
			const files = Object.entries(changes).map(([filepath, { oldHash, newHash }]) => ({
				filepath,
				oldHash: oldHash || '',
				newHash: newHash || ''
			}));
			return { files };
		} catch {
			return { files: [] };
		}
	});
