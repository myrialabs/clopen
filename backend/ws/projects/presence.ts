/**
 * Projects Presence Management
 *
 * Handles user presence updates:
 * - projects:update-presence (HTTP) - Update user presence with broadcast
 *
 * Uses `projects:presence-updated` event (declared in status.ts)
 */

import { t } from 'elysia';
import { createRouter } from '$shared/utils/ws-server';
import { updateUserPresence, getProjectStatusData } from '../../lib/project/status-manager';
import { streamManager } from '../../lib/chat/stream-manager';
import { ws } from '$backend/lib/utils/ws';
import { debug } from '$shared/utils/logger';

export const presenceHandler = createRouter()
	.http('projects:update-presence', {
		data: t.Object({
			userName: t.String({ minLength: 1 }),
			action: t.Optional(t.String())
		}),
		response: t.Any()
	}, async ({ data, conn }) => {
		const projectId = ws.getProjectId(conn);
		const userId = ws.getUserId(conn);
		const { userName, action } = data;

		updateUserPresence(projectId, userId, userName, action || 'join');

		try {
			streamManager.cleanupProjectStreams(projectId);
		} catch (cleanupError) {
			debug.error('project', 'Error cleaning up project streams:', cleanupError);
		}

		// Broadcast full presence to all clients
		const allStatuses = await getProjectStatusData();
		ws.emit.global('projects:presence-updated', {
			type: 'presence-updated',
			timestamp: Date.now(),
			data: allStatuses
		});

		return await getProjectStatusData(projectId);
	});
